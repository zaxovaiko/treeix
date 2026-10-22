//! The Treeix MCP server (treeix_core::mcp) the app runs for its agents, and its setup dialog. Owner: A5

use super::Result;
use crate::daemon::Daemon;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use treeix_core::mcp::{McpInstall, McpInstallResult, McpServer, McpTool, ToolFuture};
use treeix_proto::{CreateSession, Request, Response, SessionKind};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Off in settings, or failed to bind
    pub running: bool,
    /// `http://127.0.0.1:<port>/mcp`
    pub url: Option<String>,
    pub installs: Vec<McpInstall>,
    pub tools: Vec<McpToolInfo>,
}

#[derive(Default)]
struct Mcp {
    server: tokio::sync::Mutex<Option<McpServer>>,
    /// What `agent_env` hands out without waiting on the server lock
    env: Mutex<Vec<(String, String)>>,
}

/// In setup: starts the server when the mcp feature is on
pub(crate) fn start(app: &AppHandle) {
    app.manage(Mcp::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ensure(&app).await {
            tracing::warn!("mcp server: {e}");
        }
    });
}

/// Env an agent session needs to reach the server; empty while it is not running
pub(crate) fn agent_env(app: &AppHandle) -> Vec<(String, String)> {
    app.try_state::<Mcp>()
        .map(|mcp| {
            mcp.env
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
        .unwrap_or_default()
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn saved_port(data_dir: &Path) -> u16 {
    std::fs::read(data_dir.join("mcp.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|saved| saved["port"].as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(0)
}

/// Kept across runs: Claude Code and Codex are set up with the URL and token once
fn token(data_dir: &Path) -> Result<String> {
    use treeix_core::secrets;
    if let Some(token) = secrets::get_account(data_dir, secrets::MCP_TOKEN)? {
        return Ok(token);
    }
    let token = treeix_core::mcp::new_token()?;
    if let Err(e) = secrets::set_account(data_dir, secrets::MCP_TOKEN, &token) {
        tracing::warn!("mcp token not saved, agents need setting up again next run: {e}");
    }
    Ok(token)
}

/// Brings the server in line with the mcp setting, so turning it on or off takes effect without a restart
async fn ensure(app: &AppHandle) -> Result<()> {
    let mcp = app.state::<Mcp>();
    let mut server = mcp.server.lock().await;
    let data_dir = treeix_proto::data_dir();
    let on = {
        let data_dir = data_dir.clone();
        super::files::blocking(move || Ok(treeix_core::settings::load(&data_dir).features.mcp))
            .await?
    };
    if on == server.is_some() {
        return Ok(());
    }
    *server = None;
    if on {
        let (port, token) = super::files::blocking({
            let data_dir = data_dir.clone();
            move || Ok((saved_port(&data_dir), token(&data_dir)?))
        })
        .await?;
        let started = McpServer::start(tools(app), port, token).await?;
        if started.port != port {
            let saved =
                serde_json::to_vec(&json!({ "port": started.port })).map_err(|e| e.to_string())?;
            if let Err(e) = std::fs::write(data_dir.join("mcp.json"), saved) {
                tracing::warn!("mcp port not saved: {e}");
            }
        }
        *server = Some(started);
    }
    *mcp.env.lock().unwrap_or_else(PoisonError::into_inner) =
        server.as_ref().map(McpServer::env).unwrap_or_default();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_status(app: AppHandle) -> Result<McpStatus> {
    ensure(&app).await?;
    let mcp = app.state::<Mcp>();
    let server = mcp.server.lock().await;
    let tools = tools(&app)
        .into_iter()
        .map(|tool| McpToolInfo {
            name: tool.name,
            description: tool.description,
        })
        .collect();
    Ok(match server.as_ref() {
        Some(server) => McpStatus {
            running: true,
            url: Some(server.url()),
            installs: treeix_core::mcp::install_status(&home(), server),
            tools,
        },
        None => McpStatus {
            running: false,
            url: None,
            installs: vec![],
            tools,
        },
    })
}

/// Registers Treeix with Claude Code and Codex (user scope)
#[tauri::command]
#[specta::specta]
pub async fn mcp_install(app: AppHandle) -> Result<McpInstallResult> {
    ensure(&app).await?;
    let mcp = app.state::<Mcp>();
    let server = mcp.server.lock().await;
    let server = server
        .as_ref()
        .ok_or("The Treeix MCP server is off in Settings")?;
    // Runs the agents' CLIs, a few seconds at most; holding the lock keeps the server it names alive
    Ok(tokio::task::block_in_place(|| {
        treeix_core::mcp::install(&home(), server)
    }))
}

fn tool(
    name: &str,
    description: &str,
    input_schema: Value,
    run: impl Fn(Value) -> ToolFuture + Send + Sync + 'static,
) -> McpTool {
    McpTool {
        name: name.into(),
        description: description.into(),
        input_schema,
        run: Arc::new(run),
    }
}

fn arg(args: &Value, name: &str) -> Result<String> {
    match args[name].as_str() {
        Some(value) if !value.is_empty() => Ok(value.into()),
        _ => Err(format!("{name} is required")),
    }
}

fn opt(args: &Value, name: &str) -> Option<String> {
    args[name]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn request(app: &AppHandle, req: Request) -> Result<Response> {
    app.state::<Arc<Daemon>>().request(req).await
}

async fn write(app: &AppHandle, session: &str, data: impl Into<Vec<u8>>) -> Result<()> {
    request(
        app,
        Request::Write {
            session: session.into(),
            data: data.into(),
        },
    )
    .await
    .map(drop)
}

/// The text box gets the text as one paste; `send` presses Enter after the agent took it in
async fn type_text(app: &AppHandle, session: &str, text: &str, send: bool) -> Result<()> {
    write(app, session, format!("\x1b[200~{text}\x1b[201~")).await?;
    if send {
        tokio::time::sleep(Duration::from_millis(150)).await;
        write(app, session, "\r").await?;
    }
    Ok(())
}

/// A folder the agent names: absolute and there
fn folder(path: &str) -> Result<String> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!(
            "{} is not an absolute path to a folder",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

fn tools(app: &AppHandle) -> Vec<McpTool> {
    let session = json!({ "type": "string", "description": "Session id from sessions_list" });
    let with = |run: fn(AppHandle, Value) -> ToolFuture| {
        let app = app.clone();
        move |args: Value| run(app.clone(), args)
    };
    let mut tools = vec![
        tool(
            "sessions_list",
            "Lists the terminal and agent sessions open in Treeix: id, kind, title, status and folder.",
            json!({ "type": "object", "properties": {} }),
            with(|app, _| Box::pin(async move { sessions_list(&app).await })),
        ),
        tool(
            "session_read",
            "Reads the last lines on a session's screen, as text.",
            json!({ "type": "object", "properties": {
                "session": session,
                "count": { "type": "integer", "description": "Lines from the end, 60 by default" }
            }, "required": ["session"] }),
            with(|app, args| Box::pin(async move { session_read(&app, &args).await })),
        ),
        tool(
            "session_send",
            "Types text into a session. send=\"send\" presses Enter after it; \"ask\" leaves it for the user to send.",
            json!({ "type": "object", "properties": {
                "session": session,
                "text": { "type": "string" },
                "send": { "type": "string", "enum": ["ask", "send"] }
            }, "required": ["session", "text"] }),
            with(|app, args| {
                Box::pin(async move {
                    let session = arg(&args, "session")?;
                    type_text(&app, &session, &arg(&args, "text")?, args["send"] == "send").await?;
                    Ok(format!("Typed into {session}"))
                })
            }),
        ),
        tool(
            "session_new",
            "Opens a new session in Treeix: a Claude or Codex agent given a prompt, or a shell that runs a command.",
            json!({ "type": "object", "properties": {
                "folder": { "type": "string", "description": "Absolute path it runs in" },
                "kind": { "type": "string", "enum": ["claude", "codex", "shell"] },
                "prompt": { "type": "string", "description": "The agent's first prompt, or the shell's command" }
            }, "required": ["folder", "kind"] }),
            with(|app, args| Box::pin(async move { session_new(&app, &args).await })),
        ),
        tool(
            "worktrees_list",
            "Lists a git repository's worktrees: path, branch and short head.",
            json!({ "type": "object", "properties": {
                "repo": { "type": "string", "description": "Absolute path to the repository" }
            }, "required": ["repo"] }),
            with(|_, args| {
                Box::pin(async move {
                    let repo = folder(&arg(&args, "repo")?)?;
                    super::files::blocking(move || treeix_core::git::list_worktrees(&repo))
                        .await
                        .map(|worktrees| {
                            worktrees
                                .iter()
                                .map(|worktree| {
                                    let branch = worktree.branch.as_deref().unwrap_or("(detached)");
                                    format!("{} {branch} {}", worktree.path, worktree.head)
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                })
            }),
        ),
        tool(
            "worktree_new",
            "Adds a worktree to a git repository for a branch (made from base when new). Replies with its path.",
            json!({ "type": "object", "properties": {
                "repo": { "type": "string", "description": "Absolute path to the repository" },
                "branch": { "type": "string" },
                "base": { "type": "string", "description": "Start point of a new branch; the default branch by default" }
            }, "required": ["repo", "branch"] }),
            with(|_, args| {
                Box::pin(async move {
                    let request = treeix_core::git::NewWorktree {
                        repo_path: folder(&arg(&args, "repo")?)?,
                        branch: Some(arg(&args, "branch")?),
                        base: opt(&args, "base"),
                        pr: None,
                        copy_env: true,
                        setup: None,
                        skip_fetch: false,
                    };
                    super::files::blocking(move || treeix_core::git::add_worktree(&request, |_| {}))
                        .await
                })
            }),
        ),
    ];
    tools.extend(crate::browser::tools(app));
    tools
}

async fn sessions_list(app: &AppHandle) -> Result<String> {
    let Response::Sessions(sessions) = request(app, Request::List).await? else {
        return Err("ptyd answered no session list".into());
    };
    if sessions.is_empty() {
        return Ok("No sessions".into());
    }
    Ok(sessions
        .iter()
        .map(|info| {
            let kind = format!("{:?}", info.kind).to_lowercase();
            let status = format!("{:?}", info.status).to_lowercase();
            format!("{} {kind} {:?} {status} {}", info.id, info.title, info.cwd)
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn session_read(app: &AppHandle, args: &Value) -> Result<String> {
    let session = arg(args, "session")?;
    let count = args["count"]
        .as_u64()
        .map_or(60, |count| count.clamp(1, 2000) as usize);
    let reply = request(
        app,
        Request::Attach {
            session: session.clone(),
        },
    )
    .await?;
    // The screen is all it needed; Data that follows is dropped
    let _ = request(app, Request::Detach { session }).await;
    match reply {
        Response::Attached { snapshot, .. } => Ok(treeix_core::mcp::screen_text(
            &String::from_utf8_lossy(&snapshot),
            count,
        )),
        _ => Err("ptyd answered no screen".into()),
    }
}

async fn session_new(app: &AppHandle, args: &Value) -> Result<String> {
    let cwd = folder(&arg(args, "folder")?)?;
    let prompt = opt(args, "prompt");
    let (kind, program) = match args["kind"].as_str() {
        Some("claude") => (SessionKind::Claude, "claude"),
        Some("codex") => (SessionKind::Codex, "codex"),
        Some("shell") => (SessionKind::Shell, ""),
        _ => return Err("kind is claude, codex or shell".into()),
    };
    let command = match (kind, &prompt) {
        (SessionKind::Shell, _) => vec![],
        (_, Some(prompt)) => vec![program.to_string(), prompt.clone()],
        (_, None) => vec![program.to_string()],
    };
    let mut create = CreateSession {
        kind,
        cwd: Some(cwd),
        command,
        env: vec![],
        cols: 120,
        rows: 32,
        title: None,
        routine: None,
    };
    super::agents::prepare_agent(app, &mut create)?;
    let Response::Created(info) = request(app, Request::Create(create)).await? else {
        return Err("ptyd made no session".into());
    };
    if let (SessionKind::Shell, Some(command)) = (kind, prompt) {
        write(app, &info.id, format!("{command}\r")).await?;
    }
    Ok(format!("Opened session {}", info.id))
}
