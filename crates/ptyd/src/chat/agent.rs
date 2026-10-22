//! One chat's agent: the ACP adapter in a login shell, spoken to over stdio (port of the Electron app's acpAdapter.ts)

use super::{Chat, events, lock};
use crate::server::Daemon;
use agent_client_protocol::{Agent, ConnectionTo, Error, Lines, Responder, UntypedMessage};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use treeix_proto::chat::{
    ChatCapabilities, ChatContent, ChatEvent, ChatOption, OptionCategory, StopReason,
};

const STDERR_LIMIT: usize = 4096;
/// Silence, not total time: a slow start that keeps printing progress is not a hang
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const KILL_AFTER: Duration = Duration::from_secs(3);
const RESOURCE_NOT_FOUND: i32 = -32002;
/// Agents that add `_meta.systemPrompt.append` to their system prompt; others get instructions before the first message
const SYSTEM_PROMPT_AGENT: &str = "@agentclientprotocol/claude-agent-acp";

/// A running agent with its conversation
pub(crate) struct Conn {
    cx: ConnectionTo<Agent>,
    pub session: String,
    pub token: u64,
    pub capabilities: ChatCapabilities,
    config_options: bool,
    pgid: Pid,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

pub(crate) fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_file())
        .or_else(|| {
            Path::new("/bin/zsh")
                .is_file()
                .then(|| "/bin/zsh".to_owned())
        })
        .unwrap_or_else(|| "/bin/sh".to_owned())
}

fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

async fn call(cx: &ConnectionTo<Agent>, method: &str, params: Value) -> Result<Value, Error> {
    cx.send_request(UntypedMessage::new(method, params)?)
        .block_task()
        .await
}

impl Conn {
    /// Ends the connection; the driver hangs up the process group
    pub fn stop(&self) {
        if let Some(stop) = lock(&self.stop).take() {
            let _ = stop.send(());
        }
    }

    /// Daemon shutdown: no time to wait for the driver
    pub fn kill(&self) {
        let _ = killpg(self.pgid, Signal::SIGTERM);
    }

    pub fn cancel(&self) {
        if let Ok(cancel) =
            UntypedMessage::new("session/cancel", json!({ "sessionId": self.session }))
        {
            let _ = self.cx.send_notification(cancel);
        }
    }

    /// Runs a turn to its `turn_end`
    pub async fn prompt(&self, content: &[ChatContent]) -> Result<ChatEvent, String> {
        let params =
            json!({ "sessionId": self.session, "prompt": events::to_prompt_blocks(content) });
        let response = call(&self.cx, "session/prompt", params)
            .await
            .map_err(|e| e.message)?;
        Ok(ChatEvent::TurnEnd {
            stop_reason: serde_json::from_value(response["stopReason"].clone())
                .unwrap_or(StopReason::EndTurn),
            usage: events::turn_usage(&response["usage"]),
        })
    }

    pub async fn set_option(
        &self,
        chat: &Chat,
        option: &str,
        value: &str,
    ) -> Result<Vec<ChatOption>, String> {
        set_option(
            &self.cx,
            &self.session,
            self.config_options,
            chat,
            option,
            value,
        )
        .await
    }
}

/// Config options when the agent has them, else the legacy session mode as the `mode` option
async fn set_option(
    cx: &ConnectionTo<Agent>,
    session: &str,
    config_options: bool,
    chat: &Chat,
    option: &str,
    value: &str,
) -> Result<Vec<ChatOption>, String> {
    if config_options {
        let params = json!({ "sessionId": session, "configId": option, "value": value });
        let response = call(cx, "session/set_config_option", params)
            .await
            .map_err(|e| e.message)?;
        return Ok(events::options_from(&response));
    }
    if option != "mode" {
        return Err(format!("This agent has no option {option}"));
    }
    call(
        cx,
        "session/set_mode",
        json!({ "sessionId": session, "modeId": value }),
    )
    .await
    .map_err(|e| e.message)?;
    Ok(with_mode(&chat.state().options, value))
}

fn with_mode(options: &[ChatOption], mode: &str) -> Vec<ChatOption> {
    let mut options = options.to_vec();
    for option in options
        .iter_mut()
        .filter(|o| o.category == OptionCategory::Mode)
    {
        option.current_value = mode.to_owned();
    }
    options
}

/// The agent may only touch files inside the chat's folder, symlinks resolved
pub(crate) fn confined_path(path: &str, root: &str, write: bool) -> Result<PathBuf, String> {
    const OUTSIDE: &str = "Outside the session folder";
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Path must be absolute".into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let real = match std::fs::canonicalize(path) {
        Ok(real) => real,
        Err(e) if !write || e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e.to_string());
        }
        // A new file: its real folder plus its name. A dangling symlink would be followed by the write
        Err(_) => {
            if path.symlink_metadata().is_ok() {
                return Err(OUTSIDE.into());
            }
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                return Err(OUTSIDE.into());
            };
            std::fs::canonicalize(parent)
                .map_err(|e| e.to_string())?
                .join(name)
        }
    };
    if real.starts_with(&root) {
        Ok(real)
    } else {
        Err(OUTSIDE.into())
    }
}

/// ACP `fs/read_text_file` slicing: `line` is 1-based, `limit` counts lines
pub(crate) fn slice_lines(content: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_owned();
    }
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    let lines = content.split('\n').skip(start);
    match limit {
        Some(limit) => lines.take(limit as usize).collect::<Vec<_>>().join("\n"),
        None => lines.collect::<Vec<_>>().join("\n"),
    }
}

fn read_text_file(cwd: &str, params: &Value) -> Result<Value, String> {
    let path = confined_path(params["path"].as_str().unwrap_or_default(), cwd, false)?;
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(json!({
        "content": slice_lines(&content, params["line"].as_u64(), params["limit"].as_u64())
    }))
}

fn write_text_file(cwd: &str, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().unwrap_or_default();
    let content = params["content"].as_str().unwrap_or_default();
    // New files open exclusively, so a symlink planted after the check is not followed; an existing file is checked again
    let created = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(confined_path(path, cwd, true)?);
    match created {
        Ok(mut file) => std::io::Write::write_all(&mut file, content.as_bytes()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::write(confined_path(path, cwd, true)?, content)
        }
        Err(e) => Err(e),
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn on_update(daemon: &Daemon, chat: &Chat, token: u64, update: &Value) {
    if !daemon.chats.is_current(&chat.id, token) {
        return;
    }
    if update["sessionUpdate"] == "current_mode_update" {
        let mode = update["currentModeId"].as_str().unwrap_or_default();
        let options = {
            let mut state = chat.state();
            state.options = with_mode(&state.options, mode);
            state.options.clone()
        };
        chat.emit(daemon, ChatEvent::Options { options });
        return;
    }
    let replaying = chat.state().replaying;
    for event in events::from_session_update(update) {
        let replayed = matches!(
            event,
            ChatEvent::MessageChunk { .. }
                | ChatEvent::ThoughtChunk { .. }
                | ChatEvent::ToolCall { .. }
                | ChatEvent::ToolCallUpdate { .. }
                | ChatEvent::Plan { .. }
        );
        if replaying && replayed {
            continue;
        }
        if let ChatEvent::Options { options } = &event {
            chat.state().options.clone_from(options);
        }
        chat.emit(daemon, event);
    }
}

fn on_permission(
    daemon: &Daemon,
    chat: &Chat,
    token: u64,
    params: &Value,
    responder: Responder<Value>,
) -> Result<(), Error> {
    let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
    if !daemon.chats.is_current(&chat.id, token) {
        return responder.respond(cancelled);
    }
    let request = {
        let mut state = chat.state();
        state.next_permission += 1;
        format!("p{}", state.next_permission - 1)
    };
    let Some(event) = events::from_permission_request(&request, params) else {
        return responder.respond(cancelled);
    };
    chat.state().permissions.insert(request, responder);
    chat.emit(daemon, event);
    Ok(())
}

struct Setup {
    session: String,
    capabilities: ChatCapabilities,
    config_options: bool,
}

/// initialize, then load (resume) or a new session, then the preset on a new conversation
async fn handshake(
    cx: &ConnectionTo<Agent>,
    daemon: &Daemon,
    chat: &Chat,
    token: u64,
) -> Result<Setup, String> {
    let create = &chat.create;
    let init = call(
        cx,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true },
                "terminal": false,
                "_meta": { "subagent-transcript": true }
            },
            "clientInfo": { "name": "treeix", "version": crate::BUILD }
        }),
    )
    .await
    .map_err(|e| e.message)?;
    let caps = &init["agentCapabilities"];
    let capabilities = ChatCapabilities {
        images: caps["promptCapabilities"]["image"] == true,
        load: caps["loadSession"] == true,
        list: !caps["sessionCapabilities"]["list"].is_null(),
    };
    let takes_system_prompt = init["agentInfo"]["name"] == SYSTEM_PROMPT_AGENT;
    let env = |key: &str| {
        create
            .env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let mcp = match (
        caps["mcpCapabilities"]["http"] == true,
        env("TREEIX_MCP_URL"),
        env("TREEIX_MCP_TOKEN"),
    ) {
        (true, Some(url), Some(secret)) => json!([{
            "type": "http",
            "name": "treeix",
            "url": url,
            "headers": [{ "name": "Authorization", "value": format!("Bearer {secret}") }]
        }]),
        _ => json!([]),
    };
    let mut base = json!({ "cwd": create.cwd, "mcpServers": mcp });
    if !create.directories.is_empty()
        && !caps["sessionCapabilities"]["additionalDirectories"].is_null()
    {
        base["additionalDirectories"] = json!(create.directories);
    }

    let resume = chat.info().agent_session;
    let fresh = resume.is_none();
    let mut loaded = None;
    if let Some(session) = resume.filter(|_| capabilities.load) {
        let mut params = base.clone();
        params["sessionId"] = json!(session);
        {
            let mut state = chat.state();
            state.replaying = !state.log.is_empty();
        }
        let result = call(cx, "session/load", params).await;
        chat.state().replaying = false;
        match result {
            Ok(response) => loaded = Some((session, response)),
            // The conversation is gone: start a new one
            Err(e) if i32::from(e.code) == RESOURCE_NOT_FOUND => {}
            Err(e) => return Err(e.message),
        }
    }
    let (session, response) = match loaded {
        Some(loaded) => loaded,
        None => {
            let mut params = base;
            if let Some(instructions) = create
                .instructions
                .as_ref()
                .filter(|_| fresh && takes_system_prompt)
            {
                params["_meta"] = json!({ "systemPrompt": { "append": instructions } });
            }
            let response = call(cx, "session/new", params)
                .await
                .map_err(|e| e.message)?;
            let session = response["sessionId"]
                .as_str()
                .ok_or("The agent gave no session id")?
                .to_owned();
            (session, response)
        }
    };
    if takes_system_prompt {
        chat.state().preamble = None;
    }
    let options = events::options_from(&response);
    let config_options = response["configOptions"]
        .as_array()
        .is_some_and(|list| !list.is_empty());
    chat.state().options.clone_from(&options);
    if !daemon.chats.is_current(&chat.id, token) {
        return Err("Superseded by a newer start".into());
    }
    chat.emit(daemon, ChatEvent::Options { options });
    if fresh {
        apply_preset(cx, daemon, chat, &session, config_options).await;
    }
    Ok(Setup {
        session,
        capabilities,
        config_options,
    })
}

/// Model, then effort (its levels depend on the model), then mode. A value the agent lacks is reported, not fatal
async fn apply_preset(
    cx: &ConnectionTo<Agent>,
    daemon: &Daemon,
    chat: &Chat,
    session: &str,
    config_options: bool,
) {
    let preset = &chat.create.preset;
    for (category, name, value) in [
        (OptionCategory::Model, "model", &preset.model),
        (OptionCategory::Effort, "effort", &preset.effort),
        (OptionCategory::Mode, "mode", &preset.mode),
    ] {
        let Some(value) = value else { continue };
        let option = chat
            .state()
            .options
            .iter()
            .find(|o| o.category == category)
            .cloned();
        let message = match option {
            Some(option) if option.values.iter().any(|v| v.value == *value) => {
                if option.current_value == *value {
                    continue;
                }
                match set_option(cx, session, config_options, chat, &option.id, value).await {
                    Ok(options) => {
                        chat.state().options.clone_from(&options);
                        chat.emit(daemon, ChatEvent::Options { options });
                        continue;
                    }
                    Err(e) => format!("Could not set the {name}: {e}"),
                }
            }
            _ => format!("This agent offers no {name} \"{value}\"; using its default"),
        };
        chat.emit(daemon, ChatEvent::Error { message });
    }
}

async fn silence(activity: &Mutex<Instant>) {
    loop {
        let idle = lock(activity).elapsed();
        if idle >= CONNECT_TIMEOUT {
            return;
        }
        tokio::time::sleep(CONNECT_TIMEOUT - idle).await;
    }
}

/// Starts the agent and connects; the connection then lives in a driver task until the agent ends or `stop`
pub(crate) async fn connect(
    daemon: &Arc<Daemon>,
    chat: &Arc<Chat>,
    token: u64,
) -> Result<Arc<Conn>, String> {
    let create = &chat.create;
    if !Path::new(&create.cwd).is_dir() {
        return Err(format!("{} is gone", create.cwd));
    }
    let line = create
        .command
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = tokio::process::Command::new(login_shell());
    command
        .arg("-lc")
        .arg(format!("exec {line}"))
        .current_dir(&create.cwd)
        .envs(create.env.iter().map(|(k, v)| (k, v)))
        // ponytail: claude-agent-acp never closes an advisor call, so a turn that consults it ends in an error; drop the switch once it does
        .env("CLAUDE_CODE_DISABLE_ADVISOR_TOOL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if !create.directories.is_empty() {
        // Claude Code reads the CLAUDE.md and rules of added folders only with this set
        command.env("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "1");
    }
    let label = create.command.join(" ");
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {label}: {e}"))?;
    let (Some(pid), Some(stdin), Some(stdout), Some(mut stderr)) = (
        child.id(),
        child.stdin.take(),
        child.stdout.take(),
        child.stderr.take(),
    ) else {
        return Err(format!("Could not start {label}"));
    };
    let pgid = Pid::from_raw(pid as i32);

    let activity = Arc::new(Mutex::new(Instant::now()));
    let tail = Arc::new(Mutex::new(String::new()));
    let stderr_task = tokio::spawn({
        let (activity, tail) = (activity.clone(), tail.clone());
        async move {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = stderr.read(&mut buf).await {
                *lock(&activity) = Instant::now();
                let mut tail = lock(&tail);
                tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                if tail.len() > STDERR_LIMIT {
                    let mut cut = tail.len() - STDERR_LIMIT;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
        }
    });
    let incoming = futures::stream::unfold(
        (BufReader::new(stdout).lines(), activity.clone()),
        |(mut lines, activity)| async move {
            let line = lines.next_line().await.ok().flatten()?;
            *lock(&activity) = Instant::now();
            Some((Ok(line), (lines, activity)))
        },
    );
    let outgoing = futures::sink::unfold(stdin, |mut stdin, line: String| async move {
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok::<_, std::io::Error>(stdin)
    });

    let (ready, mut ready_rx) = mpsc::channel::<Result<Arc<Conn>, String>>(2);
    let cwd = create.cwd.clone();
    let client = agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            {
                let (daemon, chat) = (daemon.clone(), chat.clone());
                async move |message: UntypedMessage, _cx: ConnectionTo<Agent>| {
                    if message.method == "session/update" {
                        on_update(&daemon, &chat, token, &message.params["update"]);
                    }
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            {
                let (daemon, chat) = (daemon.clone(), chat.clone());
                async move |request: UntypedMessage,
                            responder: Responder<Value>,
                            _cx: ConnectionTo<Agent>| {
                    let fs_result = match request.method.as_str() {
                        "session/request_permission" => {
                            return on_permission(
                                &daemon,
                                &chat,
                                token,
                                &request.params,
                                responder,
                            );
                        }
                        "fs/read_text_file" => read_text_file(&cwd, &request.params),
                        "fs/write_text_file" => write_text_file(&cwd, &request.params),
                        _ => return responder.respond_with_error(Error::method_not_found()),
                    };
                    responder.respond_with_result(fs_result.map_err(|e| Error::new(-32603, e)))
                }
            },
            agent_client_protocol::on_receive_request!(),
        );

    let main = {
        let (daemon, chat, ready, activity, label) = (
            daemon.clone(),
            chat.clone(),
            ready.clone(),
            activity.clone(),
            label.clone(),
        );
        async move |cx: ConnectionTo<Agent>| -> Result<Option<String>, Error> {
            let setup = tokio::select! {
                setup = handshake(&cx, &daemon, &chat, token) => setup,
                () = silence(&activity) => Err(format!("{label} went silent for {}s", CONNECT_TIMEOUT.as_secs())),
            };
            let Setup {
                session,
                capabilities,
                config_options,
            } = match setup {
                Ok(setup) => setup,
                Err(failure) => return Ok(Some(failure)),
            };
            let (stop, stopped) = oneshot::channel();
            let conn = Arc::new(Conn {
                cx: cx.clone(),
                session,
                token,
                capabilities,
                config_options,
                pgid,
                stop: Mutex::new(Some(stop)),
            });
            let _ = ready.send(Ok(conn)).await;
            tokio::select! {
                () = cx.incoming_closed() => {}
                _ = stopped => {}
            }
            Ok(None)
        }
    };

    let (daemon, chat) = (daemon.clone(), chat.clone());
    tokio::spawn(async move {
        let result = client
            .connect_with(Lines::new(outgoing, incoming), main)
            .await;
        let exited = matches!(child.try_wait(), Ok(Some(_)));
        let _ = killpg(pgid, Signal::SIGTERM);
        if tokio::time::timeout(KILL_AFTER, child.wait())
            .await
            .is_err()
        {
            let _ = killpg(pgid, Signal::SIGKILL);
            let _ = child.wait().await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
        let tail = lock(&tail).trim().to_owned();
        let output = if tail.is_empty() { "no output" } else { &tail };
        let message = match result {
            Ok(Some(_)) if exited => format!("{label} exited: {output}"),
            Ok(Some(failure)) => format!("{failure}: {output}"),
            _ if tail.is_empty() => "The agent stopped".to_owned(),
            _ => format!("The agent stopped: {tail}"),
        };
        let _ = ready.send(Err(message.clone())).await;
        chat.ended(&daemon, token, message);
    });

    ready_rx
        .recv()
        .await
        .unwrap_or_else(|| Err("The agent stopped".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_slicing_takes_a_1_based_line_and_a_line_limit() {
        let content = "one\ntwo\nthree\nfour";
        assert_eq!(slice_lines(content, None, None), content);
        assert_eq!(slice_lines(content, Some(2), None), "two\nthree\nfour");
        assert_eq!(slice_lines(content, Some(2), Some(2)), "two\nthree");
        assert_eq!(slice_lines(content, None, Some(1)), "one");
    }

    #[test]
    fn paths_are_confined_to_the_folder_with_symlinks_resolved() {
        let base = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(base.path()).unwrap();
        let root = base.join("x");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("xy")).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(base.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(base.join("secret.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(base.join("nowhere.txt"), root.join("dangling.txt")).unwrap();
        let at = |name: &str| root.join(name).to_string_lossy().into_owned();
        let root_str = root.to_string_lossy().into_owned();
        let outside = Err("Outside the session folder".to_owned());

        assert_eq!(
            confined_path(&at("a.txt"), &root_str, false),
            Ok(root.join("a.txt"))
        );
        assert_eq!(
            confined_path(&at("new.txt"), &root_str, true),
            Ok(root.join("new.txt"))
        );
        assert_eq!(
            confined_path(&at("../secret.txt"), &root_str, false),
            outside
        );
        let sibling = base.join("xy/b.txt").to_string_lossy().into_owned();
        assert_eq!(confined_path(&sibling, &root_str, true), outside);
        assert_eq!(confined_path(&at("link.txt"), &root_str, false), outside);
        assert_eq!(confined_path(&at("link.txt"), &root_str, true), outside);
        assert_eq!(confined_path(&at("dangling.txt"), &root_str, true), outside);
        assert_eq!(
            confined_path("a.txt", &root_str, false),
            Err("Path must be absolute".to_owned())
        );
    }
}
