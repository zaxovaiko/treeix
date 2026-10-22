//! Chats over ACP: ptyd runs each agent's adapter (agent-client-protocol) so a chat outlives the app.
//! Each chat keeps a log of `ChatEntry`s (last 5000) in `<data dir>/chats/`; attaching replays it from a seq,
//! then streams. Contract: docs/contracts/phase45-contract.md

mod agent;
mod events;
mod title;

use crate::server::{ClientId, Daemon, Outbox};
use agent::Conn;
use agent_client_protocol::Responder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use treeix_proto::chat::{
    ChatCapabilities, ChatContent, ChatCreate, ChatEntry, ChatEvent, ChatId, ChatInfo, ChatOption,
    ChatRole, ChatStatus,
};
use treeix_proto::{Event, Request, Response, ServerMsg};

const LOG_LIMIT: usize = 5000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The latest generation per key, so a slower earlier start can tell it was superseded (generations.ts)
#[derive(Default)]
pub(crate) struct Generations(HashMap<ChatId, u64>);

impl Generations {
    pub fn begin(&mut self, key: &str) -> u64 {
        let token = self.0.get(key).map_or(1, |n| n + 1);
        self.0.insert(key.to_owned(), token);
        token
    }

    pub fn is_current(&self, key: &str, token: u64) -> bool {
        self.0.get(key) == Some(&token)
    }
}

#[derive(Default)]
pub struct Chats {
    by_id: Mutex<HashMap<ChatId, Arc<Chat>>>,
    generations: Mutex<Generations>,
}

/// `<id>.json` in the chats folder: what started the chat and its info
#[derive(Serialize, Deserialize)]
struct Saved {
    create: ChatCreate,
    info: ChatInfo,
}

pub(crate) struct Chat {
    id: ChatId,
    create: ChatCreate,
    dir: PathBuf,
    state: Mutex<State>,
    /// Held while the agent starts, so prompts queue behind one start
    starting: tokio::sync::Mutex<()>,
}

struct State {
    info: ChatInfo,
    log: VecDeque<ChatEntry>,
    file: Option<fs::File>,
    viewers: HashMap<ClientId, Outbox>,
    live: Option<Arc<Conn>>,
    permissions: HashMap<String, Responder<Value>>,
    next_permission: u64,
    options: Vec<ChatOption>,
    /// Instructions for an agent without a system prompt, put before the first message
    preamble: Option<String>,
    /// A resume replays the conversation; the log already has it unless the chat is new here
    replaying: bool,
    titling: bool,
    /// Closed chats keep no files and start no agent, whatever task still holds them
    closed: bool,
}

impl Chats {
    /// The chats a previous daemon left; their agents are gone, a prompt starts them again
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("chats");
        let mut by_id = HashMap::new();
        for path in fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
        {
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Some(Saved { create, mut info }) = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            else {
                tracing::warn!("unreadable chat {}", path.display());
                continue;
            };
            let log = load_log(&dir.join(format!("{}.jsonl", info.id)));
            info.seq = log.back().map_or(info.seq, |entry| entry.seq + 1);
            info.status = ChatStatus::Disconnected;
            let chat = Chat::new(dir.clone(), create, info, log);
            by_id.insert(chat.id.clone(), Arc::new(chat));
        }
        Self {
            by_id: Mutex::new(by_id),
            generations: Mutex::default(),
        }
    }

    pub(crate) fn get(&self, id: &str) -> Result<Arc<Chat>, String> {
        lock(&self.by_id)
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no chat {id}"))
    }

    /// Oldest first
    pub(crate) fn list(&self) -> Vec<ChatInfo> {
        let mut list: Vec<ChatInfo> = lock(&self.by_id).values().map(|c| c.info()).collect();
        list.sort_by_key(|info| info.created_at);
        list
    }

    fn begin(&self, id: &str) -> u64 {
        lock(&self.generations).begin(id)
    }

    fn is_current(&self, id: &str, token: u64) -> bool {
        lock(&self.generations).is_current(id, token)
    }

    /// Daemon shutdown: the agents go with it; the chats stay on disk for the next daemon
    pub fn stop(&self) {
        for chat in lock(&self.by_id).values() {
            self.begin(&chat.id);
            if let Some(conn) = chat.state().live.take() {
                conn.kill();
            }
        }
    }
}

/// The newest `LOG_LIMIT` entries of a log file; a longer file is rewritten to them
fn load_log(path: &Path) -> VecDeque<ChatEntry> {
    let Ok(file) = fs::File::open(path) else {
        return VecDeque::new();
    };
    let mut log = VecDeque::new();
    let mut trimmed = false;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(entry) = line
            .map_err(drop)
            .and_then(|line| serde_json::from_str(&line).map_err(drop))
        else {
            continue;
        };
        log.push_back(entry);
        if log.len() > LOG_LIMIT {
            log.pop_front();
            trimmed = true;
        }
    }
    if trimmed {
        let lines: String = log
            .iter()
            .filter_map(|entry| serde_json::to_string(entry).ok())
            .map(|line| line + "\n")
            .collect();
        if let Err(e) = write_atomic(path, lines.as_bytes()) {
            tracing::warn!("trimming {}: {e}", path.display());
        }
    }
    log
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

fn new_id() -> ChatId {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Chat {
    fn new(dir: PathBuf, create: ChatCreate, info: ChatInfo, log: VecDeque<ChatEntry>) -> Self {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{}.jsonl", info.id)))
            .map_err(|e| tracing::warn!("chat log of {}: {e}", info.id))
            .ok();
        Self {
            id: info.id.clone(),
            create,
            dir,
            state: Mutex::new(State {
                info,
                log,
                file,
                viewers: HashMap::new(),
                live: None,
                permissions: HashMap::new(),
                next_permission: 1,
                options: Vec::new(),
                preamble: None,
                replaying: false,
                titling: false,
                closed: false,
            }),
            starting: tokio::sync::Mutex::new(()),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    pub fn info(&self) -> ChatInfo {
        self.state().info.clone()
    }

    /// The info and up to the last `max` log entries from `from_seq` on, read together
    pub(crate) fn since(&self, from_seq: u64, max: usize) -> (ChatInfo, Vec<ChatEntry>) {
        let state = self.state();
        let fresh = state.log.iter().filter(|entry| entry.seq >= from_seq);
        let skip = fresh.clone().count().saturating_sub(max);
        (state.info.clone(), fresh.skip(skip).cloned().collect())
    }

    fn save(&self, info: &ChatInfo) {
        let saved = json!({ "create": &self.create, "info": info });
        let path = self.dir.join(format!("{}.json", self.id));
        if let Err(e) = write_atomic(&path, saved.to_string().as_bytes()) {
            tracing::error!("saving chat {}: {e}", self.id);
        }
    }

    /// Changes the info; a real change is saved and goes to every client
    fn update(&self, daemon: &Daemon, change: impl FnOnce(&mut ChatInfo)) {
        let info = {
            let mut state = self.state();
            let before = state.info.clone();
            change(&mut state.info);
            if state.info == before {
                return;
            }
            state.info.clone()
        };
        self.changed(daemon, info);
    }

    fn changed(&self, daemon: &Daemon, info: ChatInfo) {
        if self.state().closed {
            return;
        }
        self.save(&info);
        daemon.broadcast(Event::ChatChanged(info));
    }

    /// Logs an event, streams it to the attached clients and moves the status along
    pub fn emit(&self, daemon: &Daemon, event: ChatEvent) {
        let changed = {
            let mut state = self.state();
            let before = state.info.clone();
            let info = &mut state.info;
            match &event {
                ChatEvent::Permission { .. } => info.status = ChatStatus::Needs,
                ChatEvent::PermissionSettled { .. } if info.status == ChatStatus::Needs => {
                    info.status = ChatStatus::Running;
                }
                ChatEvent::TurnStart => info.status = ChatStatus::Running,
                ChatEvent::TurnEnd { .. } if info.status != ChatStatus::Disconnected => {
                    info.status = ChatStatus::Idle;
                }
                ChatEvent::Disconnected { .. } => info.status = ChatStatus::Disconnected,
                ChatEvent::Title { title } => info.title.clone_from(title),
                _ => {}
            }
            if matches!(event, ChatEvent::PermissionSettled { .. }) && !state.permissions.is_empty()
            {
                state.info.status = ChatStatus::Needs;
            }
            let entry = ChatEntry {
                seq: state.info.seq,
                at: now_ms(),
                event,
            };
            state.info.seq += 1;
            if let (Some(file), Ok(line)) = (&mut state.file, serde_json::to_string(&entry))
                && let Err(e) = writeln!(file, "{line}")
            {
                tracing::warn!("chat log of {}: {e}", self.id);
            }
            state.viewers.retain(|_, outbox| {
                outbox
                    .send(ServerMsg::Event(Event::Chat {
                        chat: self.id.clone(),
                        entry: entry.clone(),
                    }))
                    .is_ok()
            });
            state.log.push_back(entry);
            if state.log.len() > LOG_LIMIT {
                state.log.pop_front();
            }
            let mut after = state.info.clone();
            after.seq = before.seq;
            (after != before).then(|| state.info.clone())
        };
        if let Some(info) = changed {
            self.changed(daemon, info);
        }
    }

    fn set_status(&self, daemon: &Daemon, status: ChatStatus) {
        self.update(daemon, |info| info.status = status);
    }

    /// Answers a permission request: `option` None rejects
    fn settle(&self, daemon: &Daemon, request: &str, option: Option<String>) -> bool {
        let Some(responder) = self.state().permissions.remove(request) else {
            return false;
        };
        let outcome = match option {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        };
        let _ = responder.respond(json!({ "outcome": outcome }));
        self.emit(
            daemon,
            ChatEvent::PermissionSettled {
                request_id: request.to_owned(),
            },
        );
        true
    }

    /// No permission card may keep waiting on a turn that ended or an agent that went away
    fn settle_all(&self, daemon: &Daemon) {
        let requests: Vec<String> = self.state().permissions.keys().cloned().collect();
        for request in requests {
            self.settle(daemon, &request, None);
        }
    }

    fn has_user_message(&self) -> bool {
        self.state().log.iter().any(|entry| {
            matches!(
                entry.event,
                ChatEvent::MessageChunk {
                    role: ChatRole::User,
                    ..
                }
            )
        })
    }

    /// The running agent, started (resuming the conversation) when there is none
    async fn connection(self: &Arc<Self>, daemon: &Arc<Daemon>) -> Result<Arc<Conn>, String> {
        let _starting = self.starting.lock().await;
        {
            let state = self.state();
            if state.closed {
                return Err("The chat is closed".into());
            }
            if let Some(conn) = &state.live {
                return Ok(conn.clone());
            }
        }
        self.set_status(daemon, ChatStatus::Starting);
        let token = daemon.chats.begin(&self.id);
        match agent::connect(daemon, self, token).await {
            Ok(conn) if daemon.chats.is_current(&self.id, token) => {
                self.state().live = Some(conn.clone());
                self.update(daemon, |info| {
                    info.agent_session = Some(conn.session.clone());
                    info.capabilities = conn.capabilities;
                    info.status = ChatStatus::Idle;
                });
                Ok(conn)
            }
            Ok(conn) => {
                conn.kill();
                Err("The chat was closed while its agent started".into())
            }
            Err(message) => {
                if daemon.chats.is_current(&self.id, token) {
                    self.settle_all(daemon);
                    self.emit(
                        daemon,
                        ChatEvent::Disconnected {
                            message: message.clone(),
                        },
                    );
                }
                Err(message)
            }
        }
    }

    /// The agent's process or connection ended
    fn ended(&self, daemon: &Daemon, token: u64, message: String) {
        {
            let mut state = self.state();
            if state.live.as_ref().is_none_or(|conn| conn.token != token) {
                return;
            }
            state.live = None;
        }
        self.settle_all(daemon);
        self.emit(daemon, ChatEvent::Disconnected { message });
    }

    async fn prompt(self: Arc<Self>, daemon: Arc<Daemon>, content: Vec<ChatContent>) {
        let Ok(conn) = self.connection(&daemon).await else {
            return;
        };
        let first_text = content.iter().find_map(|item| match item {
            ChatContent::Text { text } => Some(text.clone()),
            ChatContent::Image { .. } => None,
        });
        if let Some(text) = first_text
            && self.info().title.is_empty()
            && !self.has_user_message()
            && !std::mem::replace(&mut self.state().titling, true)
        {
            tokio::spawn(title::name(daemon.clone(), self.clone(), text));
        }
        self.emit(&daemon, ChatEvent::TurnStart);
        for item in &content {
            self.emit(
                &daemon,
                ChatEvent::MessageChunk {
                    role: ChatRole::User,
                    content: item.clone(),
                    parent: None,
                },
            );
        }
        let preamble = self.state().preamble.take();
        let blocks: Vec<ChatContent> = preamble
            .map(|text| ChatContent::Text { text })
            .into_iter()
            .chain(content)
            .collect();
        let event = match conn.prompt(&blocks).await {
            Ok(event) => event,
            Err(message) => {
                self.emit(&daemon, ChatEvent::Error { message });
                ChatEvent::TurnEnd {
                    stop_reason: treeix_proto::chat::StopReason::Cancelled,
                    usage: None,
                }
            }
        };
        self.emit(&daemon, event);
    }

    async fn set_option(
        self: Arc<Self>,
        daemon: Arc<Daemon>,
        option: String,
        value: String,
    ) -> Result<(), String> {
        let conn = self.connection(&daemon).await?;
        let options = conn.set_option(&self, &option, &value).await?;
        self.state().options.clone_from(&options);
        self.emit(&daemon, ChatEvent::Options { options });
        Ok(())
    }

    fn cancel(&self, daemon: &Daemon) {
        if let Some(conn) = self.state().live.clone() {
            conn.cancel();
        }
        self.settle_all(daemon);
    }

    fn attach(&self, client: ClientId, outbox: &Outbox, id: u64, from_seq: u64) {
        let mut state = self.state();
        let _ = outbox.send(ServerMsg::Resp {
            id,
            resp: Ok(Response::Chat(state.info.clone())),
        });
        for entry in state.log.iter().filter(|entry| entry.seq >= from_seq) {
            let _ = outbox.send(ServerMsg::Event(Event::Chat {
                chat: self.id.clone(),
                entry: entry.clone(),
            }));
        }
        state.viewers.insert(client, outbox.clone());
    }
}

fn create(daemon: &Daemon, create: ChatCreate) -> Result<Arc<Chat>, String> {
    let dir = daemon.data_dir.join("chats");
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let info = ChatInfo {
        id: new_id(),
        agent: create.agent,
        cwd: create.cwd.clone(),
        title: String::new(),
        status: ChatStatus::Starting,
        agent_session: create.resume.clone(),
        capabilities: ChatCapabilities::default(),
        created_at: now_ms(),
        seq: 0,
    };
    let chat = Chat::new(dir, create, info, VecDeque::new());
    if chat.create.resume.is_none() {
        chat.state().preamble.clone_from(&chat.create.instructions);
    }
    let chat = Arc::new(chat);
    lock(&daemon.chats.by_id).insert(chat.id.clone(), chat.clone());
    chat.changed(daemon, chat.info());
    Ok(chat)
}

fn close(daemon: &Daemon, id: &str) -> Result<(), String> {
    let chat = lock(&daemon.chats.by_id)
        .remove(id)
        .ok_or_else(|| format!("no chat {id}"))?;
    daemon.chats.begin(id);
    let live = {
        let mut state = chat.state();
        state.closed = true;
        state.file = None;
        state.viewers.clear();
        for (_, responder) in state.permissions.drain() {
            let _ = responder.respond(json!({ "outcome": { "outcome": "cancelled" } }));
        }
        state.live.take()
    };
    if let Some(conn) = live {
        conn.stop();
    }
    for ext in ["json", "jsonl"] {
        let _ = fs::remove_file(chat.dir.join(format!("{id}.{ext}")));
    }
    daemon.broadcast(Event::ChatRemoved {
        chat: id.to_owned(),
    });
    Ok(())
}

/// Every `Request::Chat*`. Replies on `outbox` itself so ChatAttach can send its reply before the replayed log
pub fn handle(daemon: &Arc<Daemon>, client: ClientId, outbox: &Outbox, id: u64, req: Request) {
    let reply = |resp: Result<Response, String>| {
        let _ = outbox.send(ServerMsg::Resp { id, resp });
    };
    let chats = &daemon.chats;
    match req {
        Request::ChatCreate(spec) => match create(daemon, *spec) {
            Ok(chat) => {
                reply(Ok(Response::Chat(chat.info())));
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    let _ = chat.connection(&daemon).await;
                });
            }
            Err(e) => reply(Err(e)),
        },
        Request::ChatPrompt { chat, content } => match chats.get(&chat) {
            Ok(chat) => {
                reply(Ok(Response::Ok));
                tokio::spawn(chat.prompt(daemon.clone(), content));
            }
            Err(e) => reply(Err(e)),
        },
        Request::ChatCancel { chat } => reply(chats.get(&chat).map(|chat| {
            chat.cancel(daemon);
            Response::Ok
        })),
        Request::ChatAnswer {
            chat,
            request,
            option,
        } => reply(chats.get(&chat).and_then(|chat| {
            chat.settle(daemon, &request, option)
                .then_some(Response::Ok)
                .ok_or_else(|| format!("no permission request {request}"))
        })),
        Request::ChatSetOption {
            chat,
            option,
            value,
        } => match chats.get(&chat) {
            Ok(chat) => {
                let (daemon, outbox) = (daemon.clone(), outbox.clone());
                tokio::spawn(async move {
                    let resp = chat.set_option(daemon, option, value).await;
                    let _ = outbox.send(ServerMsg::Resp {
                        id,
                        resp: resp.map(|()| Response::Ok),
                    });
                });
            }
            Err(e) => reply(Err(e)),
        },
        Request::ChatList => reply(Ok(Response::Chats(chats.list()))),
        Request::ChatAttach { chat, from_seq } => match chats.get(&chat) {
            Ok(chat) => chat.attach(client, outbox, id, from_seq),
            Err(e) => reply(Err(e)),
        },
        Request::ChatDetach { chat } => reply(chats.get(&chat).map(|chat| {
            chat.state().viewers.remove(&client);
            Response::Ok
        })),
        Request::ChatClose { chat } => reply(close(daemon, &chat).map(|()| Response::Ok)),
        other => reply(Err(format!("not a chat request: {other:?}"))),
    }
}

/// A client disconnected: stop streaming to it. Its chats keep running
pub fn client_gone(daemon: &Daemon, client: ClientId) {
    for chat in lock(&daemon.chats.by_id).values() {
        chat.state().viewers.remove(&client);
    }
}

#[cfg(test)]
mod tests {
    use super::Generations;

    #[test]
    fn the_latest_token_is_current() {
        let mut generations = Generations::default();
        let first = generations.begin("chat");
        let second = generations.begin("chat");
        assert!(!generations.is_current("chat", first));
        assert!(generations.is_current("chat", second));
    }

    #[test]
    fn keys_are_independent() {
        let mut generations = Generations::default();
        let a = generations.begin("a");
        generations.begin("b");
        assert!(generations.is_current("a", a));
    }

    #[test]
    fn a_key_never_started_is_never_current() {
        let generations = Generations::default();
        assert!(!generations.is_current("chat", 0));
        assert!(!generations.is_current("chat", 1));
    }
}
