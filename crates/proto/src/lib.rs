//! Wire protocol between the app and `treeix-ptyd`: postcard frames behind a u32 little-endian length.
//! Only ever add variants at the end of an enum: postcard encodes variants by index.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io;
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub mod chat;
pub mod routines;
use chat::{ChatContent, ChatCreate, ChatEntry, ChatId, ChatInfo};
use routines::{Routine, RoutineId, RoutineRun, RunId};

/// Bumped on any incompatible change. The daemon only reports it: the app compares and sends Upgrade (or
/// Shutdown), so an older app never takes down a newer daemon by connecting
pub const PROTO_VERSION: u32 = 5;
/// Bundle id; also the data dir name
pub const APP_ID: &str = "com.dyvertex.treeix";
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub type SessionId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionKind {
    Shell,
    Claude,
    Codex,
    Routine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
    Running,
    /// Agent waits for the user (permission prompt, question)
    Needs,
    /// Agent finished its turn
    Done,
    Idle,
    Exited,
    Error,
    /// Came back from a snapshot after a daemon restart or reboot; no process yet
    Restored,
    /// The daemon died while it ran; scrollback is from the last snapshot
    Crashed,
    /// An agent's turn ended with a shell, monitor or subagent left running (its screen footer says so)
    Watching,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub kind: SessionKind,
    pub cwd: String,
    pub title: String,
    pub status: SessionStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    /// Unix millis
    pub created_at: u64,
    pub command: Vec<String>,
    /// Bytes of output produced so far; the seq the next Data event starts at
    pub seq: u64,
    /// Agent conversation id (claude --resume / codex resume), when known
    pub agent_session: Option<String>,
    /// Routine that started this session
    pub routine: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateSession {
    pub kind: SessionKind,
    /// Defaults to $HOME
    pub cwd: Option<String>,
    /// Defaults to the login shell
    pub command: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub title: Option<String>,
    pub routine: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Request {
    Create(CreateSession),
    Write {
        session: SessionId,
        data: Vec<u8>,
    },
    Resize {
        session: SessionId,
        cols: u16,
        rows: u16,
    },
    /// SIGHUP to the process group, SIGKILL after a grace period
    Kill {
        session: SessionId,
    },
    /// Forget an exited session and its snapshot
    Remove {
        session: SessionId,
    },
    /// Start streaming Data for a session. The reply carries the screen + scrollback as ANSI
    /// and the seq it ends at; Data events continue from there
    Attach {
        session: SessionId,
    },
    Detach {
        session: SessionId,
    },
    /// Bytes the frontend has finished rendering. A client that fell behind gets a Resync once it has caught up
    Ack {
        session: SessionId,
        bytes: u64,
    },
    List,
    /// Opaque UI state (tabs, split trees, groups, collapse), persisted next to the sessions
    GetUi,
    PutUi {
        json: String,
    },
    /// Snapshot everything and exit (upgrade, tests)
    Shutdown,
    /// Start an exited, restored or crashed session again with its command and cwd, keeping its id
    Restart {
        session: SessionId,
    },
    /// Shift+Cmd+K: drop the scrollback and the lines above the cursor, which moves to the top. The alternate
    /// screen is left alone
    Clear {
        session: SessionId,
    },
    /// Attach for one of several views on this connection (the app's webview channels): each gets its own
    /// snapshot, ChannelData, flow control and Resync
    AttachChannel {
        session: SessionId,
        channel: u32,
    },
    DetachChannel {
        session: SessionId,
        channel: u32,
    },
    AckChannel {
        session: SessionId,
        channel: u32,
        bytes: u64,
    },
    /// Starts an agent over ACP; replies Chat
    ChatCreate(Box<ChatCreate>),
    /// Starts a turn and replies at once; the turn streams as Chat events. Restarts a disconnected agent first
    ChatPrompt {
        chat: ChatId,
        #[serde(with = "chat::as_json")]
        content: Vec<ChatContent>,
    },
    ChatCancel {
        chat: ChatId,
    },
    /// `option` None rejects the permission request
    ChatAnswer {
        chat: ChatId,
        request: String,
        option: Option<String>,
    },
    ChatSetOption {
        chat: ChatId,
        option: String,
        value: String,
    },
    /// Replies Chats
    ChatList,
    /// Replies Chat, then sends this client the log from `from_seq` and every new event as Chat events
    ChatAttach {
        chat: ChatId,
        from_seq: u64,
    },
    ChatDetach {
        chat: ChatId,
    },
    /// Stops the agent and drops the chat and its log
    ChatClose {
        chat: ChatId,
    },
    /// The app found a terminal agent's conversation id (codex rollouts); broadcasts AgentSession when it changed
    SetAgentSession {
        session: SessionId,
        agent_session: String,
    },
    /// Replies Routines
    RoutineList,
    /// Creates (empty id) or replaces a routine and replies Routine; ptyd fills id, created_at and a webhook token
    RoutinePut {
        #[serde(with = "chat::as_json")]
        routine: Routine,
    },
    /// Drops the routine; its runs stay in history. Replies Ok
    RoutineRemove {
        routine: RoutineId,
    },
    /// Queues a Manual run, even of a disabled routine; replies Run
    RoutineRunNow {
        routine: RoutineId,
    },
    /// Newest first, at most `limit`; None lists every routine's. Replies Runs
    RoutineRuns {
        routine: Option<RoutineId>,
        limit: u32,
    },
    /// Stops a queued or running run (kills its session), which ends Cancelled. Replies Ok
    RunCancel {
        run: RunId,
    },
    /// Replies Ok, then execs `exe` (a newer daemon) in place: the pid and every live session carry over.
    /// A daemon older than this can't decode it and hangs up instead
    Upgrade {
        exe: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Response {
    Ok,
    Created(SessionInfo),
    Attached {
        snapshot: Vec<u8>,
        seq: u64,
        info: SessionInfo,
    },
    Sessions(Vec<SessionInfo>),
    Ui(Option<String>),
    Chat(ChatInfo),
    Chats(Vec<ChatInfo>),
    Routines(#[serde(with = "chat::as_json")] Vec<Routine>),
    Routine(#[serde(with = "chat::as_json")] Routine),
    Runs(Vec<RoutineRun>),
    Run(RoutineRun),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Event {
    /// Output of an attached session; `seq` is the offset of the first byte
    Data {
        session: SessionId,
        seq: u64,
        bytes: Vec<u8>,
    },
    Status {
        session: SessionId,
        status: SessionStatus,
    },
    Exit {
        session: SessionId,
        code: Option<i32>,
    },
    Title {
        session: SessionId,
        title: String,
    },
    Cwd {
        session: SessionId,
        cwd: String,
    },
    /// OSC 9 / OSC 777 desktop notification
    Notify {
        session: SessionId,
        title: String,
        body: String,
    },
    Bell {
        session: SessionId,
    },
    Created(SessionInfo),
    Removed {
        session: SessionId,
    },
    /// Data for an AttachChannel stream
    ChannelData {
        session: SessionId,
        channel: u32,
        seq: u64,
        bytes: Vec<u8>,
    },
    /// The client fell more than the high-water mark behind and got no Data since. This screen (as on Attach)
    /// replaces what it skipped, and Data continues from `seq`. `channel` is None for a plain Attach
    Resync {
        session: SessionId,
        channel: Option<u32>,
        seq: u64,
        snapshot: Vec<u8>,
    },
    /// The agent's conversation id became known or changed (statusline, /clear, resume)
    AgentSession {
        session: SessionId,
        agent_session: String,
    },
    /// One log entry of an attached chat, in seq order
    Chat {
        chat: ChatId,
        #[serde(with = "chat::as_json")]
        entry: ChatEntry,
    },
    /// A chat was created or its info changed (status, title, agent session); goes to every client
    ChatChanged(ChatInfo),
    ChatRemoved {
        chat: ChatId,
    },
    /// OSC 9;4 progress of the session's program; Off clears it
    Progress {
        session: SessionId,
        state: ProgressState,
        percent: u8,
    },
    /// A routine was created or changed; goes to every client
    RoutineChanged(#[serde(with = "chat::as_json")] Routine),
    RoutineRemoved {
        routine: RoutineId,
    },
    /// A run was queued, started, progressed (turns, cost) or ended; goes to every client
    RunChanged(RoutineRun),
    /// A shell started Claude or Codex in the foreground, or got back to its prompt
    Kind {
        session: SessionId,
        kind: SessionKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProgressState {
    Off,
    Normal,
    Error,
    /// Busy with no percent
    Indeterminate,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClientMsg {
    Hello { proto: u32, build: String },
    Req { id: u64, req: Request },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ServerMsg {
    Hello {
        proto: u32,
        build: String,
        pid: u32,
    },
    Resp {
        id: u64,
        resp: Result<Response, String>,
    },
    Event(Event),
}

/// `~/Library/Application Support/<APP_ID>` on macOS, `$XDG_DATA_HOME/<APP_ID>` elsewhere; `TREEIX_DATA_DIR` overrides (tests)
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TREEIX_DATA_DIR") {
        return dir.into();
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into()));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(APP_ID)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join(APP_ID)
    }
}

/// `$XDG_RUNTIME_DIR/<APP_ID>.sock` on Linux when the session has one, else `<data_dir>/ptyd.sock`
pub fn socket_path() -> PathBuf {
    if cfg!(not(target_os = "macos"))
        && std::env::var_os("TREEIX_DATA_DIR").is_none()
        && let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty())
    {
        return PathBuf::from(runtime).join(format!("{APP_ID}.sock"));
    }
    data_dir().join("ptyd.sock")
}

pub fn encode<T: Serialize>(msg: &T) -> io::Result<Vec<u8>> {
    let body = postcard::to_stdvec(msg).map_err(io::Error::other)?;
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    w: &mut W,
    msg: &T,
) -> io::Result<()> {
    w.write_all(&encode(msg)?).await
}

/// `Ok(None)` on a clean EOF between frames
pub async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    r: &mut R,
) -> io::Result<Option<T>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame of {len} bytes"),
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    postcard::from_bytes(&body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip() {
        let msgs = vec![
            ServerMsg::Hello {
                proto: PROTO_VERSION,
                build: "t".into(),
                pid: 1,
            },
            ServerMsg::Event(Event::Data {
                session: "s1".into(),
                seq: 42,
                bytes: b"\x1b[31mhi".to_vec(),
            }),
            ServerMsg::Resp {
                id: 7,
                resp: Err("no such session".into()),
            },
        ];
        let mut buf = Vec::new();
        for m in &msgs {
            write_frame(&mut buf, m).await.unwrap();
        }
        let mut r = buf.as_slice();
        for m in &msgs {
            assert_eq!(
                read_frame::<_, ServerMsg>(&mut r).await.unwrap().as_ref(),
                Some(m)
            );
        }
        assert_eq!(read_frame::<_, ServerMsg>(&mut r).await.unwrap(), None);
    }

    #[test]
    fn routines_round_trip_through_postcard() {
        use chat::ChatAgent;
        use routines::*;
        let routine = Routine {
            id: "rt-1".into(),
            name: "Review".into(),
            enabled: true,
            agent: ChatAgent::Claude,
            prompt: "Review {pr}".into(),
            trigger: Trigger::Event {
                event: RoutineEvent::ReviewRequested,
            },
            repo: None,
            place: RoutinePlace::PrWorktree,
            permission: RoutinePermission::ReadOnly,
            allowed_tools: vec![],
            budget: Budget {
                max_turns: Some(20),
                max_cost: Some(2.0),
            },
            result: RoutineResult::Local,
            may_comment: false,
            asleep: WhileAsleep::Skip,
            created_at: 1,
        };
        let msg = ServerMsg::Event(Event::RoutineChanged(routine));
        let bytes = postcard::to_stdvec(&msg).unwrap();
        assert_eq!(postcard::from_bytes::<ServerMsg>(&bytes).unwrap(), msg);
    }

    /// Any app and daemon must agree on these bytes forever: they are how an app replaces a daemon of
    /// another build
    #[test]
    fn handshake_and_shutdown_bytes_are_stable() {
        let hello = ClientMsg::Hello {
            proto: 1,
            build: "b".into(),
        };
        assert_eq!(postcard::to_stdvec(&hello).unwrap(), [0, 1, 1, b'b']);
        let hello = ServerMsg::Hello {
            proto: 1,
            build: "b".into(),
            pid: 2,
        };
        assert_eq!(postcard::to_stdvec(&hello).unwrap(), [0, 1, 1, b'b', 2]);
        let shutdown = ClientMsg::Req {
            id: 3,
            req: Request::Shutdown,
        };
        assert_eq!(postcard::to_stdvec(&shutdown).unwrap(), [1, 3, 11]);
        // A newer app sends this to whatever daemon runs, so its index never moves
        let upgrade = ClientMsg::Req {
            id: 3,
            req: Request::Upgrade { exe: "x".into() },
        };
        assert_eq!(postcard::to_stdvec(&upgrade).unwrap(), [1, 3, 33, 1, b'x']);
        let ok = ServerMsg::Resp {
            id: 3,
            resp: Ok(Response::Ok),
        };
        assert_eq!(postcard::to_stdvec(&ok).unwrap(), [1, 3, 0, 0]);
    }
}
