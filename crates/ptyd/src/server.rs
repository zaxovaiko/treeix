//! The socket server: handshake, requests, event fan-out, persistence timers.

use crate::procinfo;
use crate::session::{Session, Viewer};
use crate::state::{self, SavedSession, State};
use anyhow::{Context, bail};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, getpgid};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::Notify;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use treeix_proto::{
    ClientMsg, CreateSession, Event, PROTO_VERSION, Request, Response, ServerMsg, SessionId,
    SessionInfo, SessionStatus, encode, read_frame,
};

pub type ClientId = u64;
pub type Outbox = tokio::sync::mpsc::UnboundedSender<ServerMsg>;

const STATE_DEBOUNCE: Duration = Duration::from_millis(500);
const SNAPSHOT_EVERY: Duration = Duration::from_secs(30);
const POLL_FOREGROUND_EVERY: Duration = Duration::from_secs(2);

pub struct Daemon {
    pub data_dir: PathBuf,
    pub build: String,
    sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
    clients: Mutex<HashMap<ClientId, Outbox>>,
    next_client: AtomicU64,
    ui: Mutex<Option<String>>,
    state_dirty: Notify,
    state_write: Mutex<()>,
    pub shutdown: Notify,
    stopping: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Daemon {
    /// Loads the last state; sessions that were running come back without a process
    pub fn load(data_dir: PathBuf, build: String) -> Arc<Self> {
        let saved = state::load(&data_dir);
        let revived = if saved.clean_shutdown {
            SessionStatus::Restored
        } else {
            SessionStatus::Crashed
        };
        let mut sessions = HashMap::new();
        for SavedSession { info, env, started } in saved.sessions {
            let was_running = !matches!(info.status, SessionStatus::Exited | SessionStatus::Error);
            if was_running && let (Some(pid), Some(started)) = (info.pid, started) {
                kill_orphan(pid as i32, started);
            }
            let session = Session::new(info, env, true);
            if was_running {
                session.set_status(revived);
            }
            if let Some(ansi) = state::load_snapshot(&data_dir, &session.id) {
                session.load_snapshot(&ansi);
            }
            sessions.insert(session.id.clone(), session);
        }
        Arc::new(Self {
            data_dir,
            build,
            sessions: Mutex::new(sessions),
            clients: Mutex::default(),
            next_client: AtomicU64::new(1),
            ui: Mutex::new(saved.ui),
            state_dirty: Notify::new(),
            state_write: Mutex::new(()),
            shutdown: Notify::new(),
            stopping: AtomicBool::new(false),
        })
    }

    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    pub fn broadcast(&self, event: Event) {
        for outbox in lock(&self.clients).values() {
            let _ = outbox.send(ServerMsg::Event(event.clone()));
        }
    }

    pub fn mark_state_dirty(&self) {
        self.state_dirty.notify_one();
    }

    pub fn contains(&self, id: &str) -> bool {
        lock(&self.sessions).contains_key(id)
    }

    fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        lock(&self.sessions)
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no session {id}"))
    }

    fn sessions(&self) -> Vec<Arc<Session>> {
        lock(&self.sessions).values().cloned().collect()
    }

    pub fn save_state(&self, clean_shutdown: bool) {
        let _guard = lock(&self.state_write);
        let mut sessions: Vec<SavedSession> = self
            .sessions()
            .iter()
            .map(|s| SavedSession {
                info: s.info(),
                env: s.env.clone(),
                started: s.started(),
            })
            .collect();
        sessions.sort_by_key(|s| s.info.created_at);
        let state = State {
            clean_shutdown,
            ui: lock(&self.ui).clone(),
            sessions,
        };
        if let Err(e) = state::save(&self.data_dir, &state) {
            tracing::error!("saving state.json: {e}");
        }
    }

    fn save_snapshot(&self, session: &Session) {
        session.dirty.store(false, Ordering::Relaxed);
        if let Err(e) = state::save_snapshot(&self.data_dir, &session.id, &session.snapshot()) {
            tracing::error!("saving snapshot of {}: {e}", session.id);
        }
    }

    fn snapshot_in_background(self: &Arc<Self>, session: Arc<Session>) {
        let daemon = self.clone();
        tokio::task::spawn_blocking(move || daemon.save_snapshot(&session));
    }

    /// Snapshot every session, write a clean state, hang up the children. Idempotent
    pub fn stop(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        let sessions = self.sessions();
        for session in &sessions {
            self.save_snapshot(session);
        }
        self.save_state(true);
        for session in &sessions {
            session.signal(Signal::SIGHUP);
        }
        tracing::info!("stopped with {} sessions", sessions.len());
    }

    /// Debounced state.json writes, periodic snapshots of busy sessions, foreground polling
    pub fn spawn_timers(self: &Arc<Self>) {
        let daemon = self.clone();
        tokio::spawn(async move {
            loop {
                daemon.state_dirty.notified().await;
                tokio::time::sleep(STATE_DEBOUNCE).await;
                if daemon.stopping() {
                    return;
                }
                let d = daemon.clone();
                let _ = tokio::task::spawn_blocking(move || d.save_state(false)).await;
            }
        });
        let daemon = self.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(SNAPSHOT_EVERY);
            loop {
                every.tick().await;
                for session in daemon.sessions() {
                    if session.dirty.load(Ordering::Relaxed) && !daemon.stopping() {
                        daemon.snapshot_in_background(session);
                    }
                }
            }
        });
        let daemon = self.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(POLL_FOREGROUND_EVERY);
            loop {
                every.tick().await;
                for session in daemon.sessions() {
                    session.poll_foreground(&daemon);
                }
            }
        });
    }

    pub async fn serve(self: Arc<Self>, stream: UnixStream) -> anyhow::Result<()> {
        let peer = stream.peer_cred()?.uid();
        if peer != nix::unistd::getuid().as_raw() {
            bail!("rejected peer uid {peer}");
        }
        let (mut reader, writer) = stream.into_split();
        let Some(ClientMsg::Hello { proto, build }) = read_frame(&mut reader).await? else {
            bail!("the first frame was not Hello");
        };
        let (outbox, rx) = unbounded_channel();
        tokio::spawn(write_frames(writer, rx));
        let hello = ServerMsg::Hello {
            proto: PROTO_VERSION,
            build: self.build.clone(),
            pid: std::process::id(),
        };
        let _ = outbox.send(hello);
        if proto != PROTO_VERSION || build != self.build {
            // The app decides: a newer one sends Shutdown, an older one must not take this daemon down
            tracing::info!(
                "client is proto {proto} build {build}, daemon is {}",
                self.build
            );
        }

        let client = self.next_client.fetch_add(1, Ordering::Relaxed);
        lock(&self.clients).insert(client, outbox.clone());
        let result = loop {
            match read_frame(&mut reader).await {
                Ok(Some(ClientMsg::Req { id, req })) => self.handle(client, &outbox, id, req),
                Ok(Some(ClientMsg::Hello { .. })) => {}
                Ok(None) => break Ok(()),
                Err(e) => break Err(e.into()),
            }
        };
        lock(&self.clients).remove(&client);
        for session in self.sessions() {
            if session.detach(|viewer| viewer.0 == client) {
                self.snapshot_in_background(session);
            }
        }
        result
    }

    fn handle(self: &Arc<Self>, client: ClientId, outbox: &Outbox, id: u64, req: Request) {
        if let Request::Attach { session } | Request::AttachChannel { session, .. } = &req {
            let channel = match req {
                Request::AttachChannel { channel, .. } => Some(channel),
                _ => None,
            };
            match self.session(session) {
                Ok(session) => session.attach((client, channel), outbox, id),
                Err(e) => {
                    let _ = outbox.send(ServerMsg::Resp { id, resp: Err(e) });
                }
            }
            return;
        }
        let shutdown = matches!(req, Request::Shutdown);
        let resp = self.respond(client, req);
        let _ = outbox.send(ServerMsg::Resp { id, resp });
        if shutdown {
            self.shutdown.notify_one();
        }
    }

    fn respond(self: &Arc<Self>, client: ClientId, req: Request) -> Result<Response, String> {
        match req {
            Request::Create(create) => self
                .create(create)
                .map(Response::Created)
                .map_err(|e| format!("{e:#}")),
            Request::Write { session, data } => {
                let session = self.session(&session)?;
                if !session.is_live() {
                    return Err(format!("session {} is not running", session.id));
                }
                session.write(data);
                Ok(Response::Ok)
            }
            Request::Resize {
                session,
                cols,
                rows,
            } => {
                self.session(&session)?
                    .resize(cols, rows)
                    .map_err(|e| e.to_string())?;
                self.mark_state_dirty();
                Ok(Response::Ok)
            }
            Request::Kill { session } => {
                self.session(&session)?.kill();
                Ok(Response::Ok)
            }
            Request::Remove { session } => {
                let removed = lock(&self.sessions)
                    .remove(&session)
                    .ok_or_else(|| format!("no session {session}"))?;
                removed.kill();
                state::remove_snapshot(&self.data_dir, &session);
                self.broadcast(Event::Removed { session });
                self.mark_state_dirty();
                Ok(Response::Ok)
            }
            Request::Attach { .. } | Request::AttachChannel { .. } => {
                unreachable!("answered in handle")
            }
            Request::Detach { session } => self.detach(&session, (client, None)),
            Request::DetachChannel { session, channel } => {
                self.detach(&session, (client, Some(channel)))
            }
            Request::Ack { session, bytes } => {
                self.session(&session)?.ack((client, None), bytes);
                Ok(Response::Ok)
            }
            Request::AckChannel {
                session,
                channel,
                bytes,
            } => {
                self.session(&session)?.ack((client, Some(channel)), bytes);
                Ok(Response::Ok)
            }
            Request::List => {
                let mut list: Vec<SessionInfo> = self.sessions().iter().map(|s| s.info()).collect();
                list.sort_by_key(|s| s.created_at);
                Ok(Response::Sessions(list))
            }
            Request::GetUi => Ok(Response::Ui(lock(&self.ui).clone())),
            Request::PutUi { json } => {
                *lock(&self.ui) = Some(json);
                self.mark_state_dirty();
                Ok(Response::Ok)
            }
            Request::Shutdown => {
                self.stop();
                Ok(Response::Ok)
            }
            Request::Restart { session } => {
                let session = self.session(&session)?;
                if session.is_live() {
                    return Err(format!("session {} is running", session.id));
                }
                session.spawn(self, true).map_err(|e| format!("{e:#}"))?;
                self.broadcast(Event::Status {
                    session: session.id.clone(),
                    status: SessionStatus::Running,
                });
                self.mark_state_dirty();
                Ok(Response::Ok)
            }
            Request::Clear { session } => {
                self.session(&session)?.clear();
                Ok(Response::Ok)
            }
        }
    }

    fn detach(self: &Arc<Self>, session: &str, viewer: Viewer) -> Result<Response, String> {
        let session = self.session(session)?;
        if session.detach(|v| *v == viewer) {
            self.snapshot_in_background(session);
        }
        Ok(Response::Ok)
    }

    fn create(self: &Arc<Self>, create: CreateSession) -> anyhow::Result<SessionInfo> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let title = create.title.clone().unwrap_or_else(|| {
            let program = create
                .command
                .first()
                .cloned()
                .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_default());
            program.rsplit('/').next().unwrap_or_default().to_owned()
        });
        let info = SessionInfo {
            id: new_id(),
            kind: create.kind,
            cwd: create.cwd.unwrap_or(home),
            title,
            status: SessionStatus::Running,
            pid: None,
            exit_code: None,
            cols: create.cols,
            rows: create.rows,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
            command: create.command,
            seq: 0,
            agent_session: None,
            routine: create.routine,
        };
        let session = Session::new(info, create.env, create.title.is_some());
        session
            .spawn(self, false)
            .with_context(|| format!("starting {:?}", session.info().command))?;
        lock(&self.sessions).insert(session.id.clone(), session.clone());
        let info = session.info();
        self.broadcast(Event::Created(info.clone()));
        self.mark_state_dirty();
        Ok(info)
    }
}

/// A shell that outlived its daemon (SIGKILL, or SIGHUP ignored) has no PTY reader any more. Its group
/// goes, but only when the pid is still that process: same start time and still its own group leader
fn kill_orphan(pid: i32, started: u64) {
    let target = Pid::from_raw(pid);
    if procinfo::start_time(pid) == Some(started) && getpgid(Some(target)) == Ok(target) {
        tracing::info!("killing orphaned process group {pid}");
        let _ = killpg(target, Signal::SIGKILL);
    }
}

/// Batches whatever is queued into one write
async fn write_frames(writer: OwnedWriteHalf, mut rx: UnboundedReceiver<ServerMsg>) {
    let mut writer = BufWriter::with_capacity(256 * 1024, writer);
    while let Some(msg) = rx.recv().await {
        let mut next = Some(msg);
        while let Some(msg) = next {
            let Ok(frame) = encode(&msg) else { return };
            if writer.write_all(&frame).await.is_err() {
                return;
            }
            next = rx.try_recv().ok();
        }
        if writer.flush().await.is_err() {
            return;
        }
    }
}

fn new_id() -> SessionId {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
