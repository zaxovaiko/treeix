//! One PTY session: the child process, its parsed screen, and the clients streaming it.

use crate::osc::{Osc, OscScanner};
use crate::server::{ClientId, Daemon, Outbox};
use crate::{procinfo, snapshot};
use alacritty_terminal::event::{Event as TermEvent, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, mpsc};
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::{Instant, sleep_until};
use treeix_proto::{Event, Response, ServerMsg, SessionId, SessionInfo, SessionStatus};

const READ_BUF: usize = 64 * 1024;
const MAX_DATA_FRAME: usize = 64 * 1024;
const COALESCE: Duration = Duration::from_millis(5);
/// Unacked bytes above which the reader stops reading the PTY
const HIGH_WATER: u64 = 1024 * 1024;
const LOW_WATER: u64 = 256 * 1024;
const HISTORY: usize = 10_000;
pub const ATTACH_HISTORY: usize = 5_000;
const KILL_GRACE: Duration = Duration::from_secs(2);

pub struct Session {
    pub id: SessionId,
    pub env: Vec<(String, String)>,
    info: Mutex<SessionInfo>,
    vt: Mutex<Vt>,
    seq: AtomicU64,
    flow: Mutex<Flow>,
    credit: Condvar,
    process: Mutex<Option<Process>>,
    term_events: Arc<Mutex<Vec<TermEvent>>>,
    /// A title came from the app or an OSC sequence, so the foreground process name is not used
    has_title: AtomicBool,
    /// Output since the last snapshot
    pub dirty: AtomicBool,
}

struct Vt {
    term: Term<Listener>,
    parser: Processor<StdSyncHandler>,
    osc: OscScanner,
    seq: u64,
}

impl Vt {
    /// Bytes held back by a synchronized update (DEC 2026) are applied, so the screen matches `seq`
    fn settle(&mut self) {
        if self.parser.sync_timeout().sync_timeout().is_some() {
            self.parser.stop_sync(&mut self.term);
        }
    }
}

#[derive(Default)]
struct Flow {
    clients: HashMap<ClientId, Attached>,
    paused: bool,
    /// Killed or exiting: read without waiting for acks
    closing: bool,
}

struct Attached {
    /// Bytes before this seq were in the attach snapshot
    from_seq: u64,
    unacked: u64,
    outbox: Outbox,
}

struct Process {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    pid: u32,
}

enum Output {
    Data { seq: u64, bytes: Vec<u8> },
    Exit(Option<i32>),
}

struct Listener(Arc<Mutex<Vec<TermEvent>>>);

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        if matches!(
            event,
            TermEvent::Title(_) | TermEvent::ResetTitle | TermEvent::Bell | TermEvent::PtyWrite(_)
        ) {
            lock(&self.0).push(event);
        }
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

fn size(cols: u16, rows: u16) -> Size {
    Size {
        cols: cols.max(2) as usize,
        rows: rows.max(1) as usize,
    }
}

/// A panicked reader thread must not take the daemon down with poisoned locks
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Session {
    pub fn new(info: SessionInfo, env: Vec<(String, String)>, has_title: bool) -> Arc<Self> {
        let term_events = Arc::new(Mutex::new(Vec::new()));
        let config = Config {
            scrolling_history: HISTORY,
            ..Config::default()
        };
        let term = Term::new(
            config,
            &size(info.cols, info.rows),
            Listener(term_events.clone()),
        );
        Arc::new(Self {
            id: info.id.clone(),
            env,
            seq: AtomicU64::new(info.seq),
            vt: Mutex::new(Vt {
                term,
                parser: Processor::new(),
                osc: OscScanner::default(),
                seq: info.seq,
            }),
            info: Mutex::new(info),
            flow: Mutex::default(),
            credit: Condvar::new(),
            process: Mutex::new(None),
            term_events,
            has_title: AtomicBool::new(has_title),
            dirty: AtomicBool::new(false),
        })
    }

    pub fn info(&self) -> SessionInfo {
        let mut info = lock(&self.info).clone();
        info.seq = self.seq.load(Ordering::Acquire);
        info
    }

    pub fn is_live(&self) -> bool {
        lock(&self.process).is_some()
    }

    /// Starts the session's command in its cwd. `restart` keeps the old screen above the new
    /// output. Must run inside the tokio runtime
    pub fn spawn(self: &Arc<Self>, daemon: &Arc<Daemon>, restart: bool) -> anyhow::Result<()> {
        let info = self.info();
        let pair = native_pty_system().openpty(PtySize {
            rows: info.rows.max(1),
            cols: info.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = match info.command.split_first() {
            Some((program, args)) => {
                let mut cmd = CommandBuilder::new(program);
                cmd.args(args);
                cmd
            }
            None => {
                let mut cmd = CommandBuilder::new(login_shell());
                cmd.arg("-l");
                cmd
            }
        };
        cmd.cwd(&info.cwd);
        if ["LANG", "LC_ALL", "LC_CTYPE"]
            .iter()
            .all(|k| std::env::var_os(k).is_none())
        {
            // launchd starts the daemon without a locale; shells then mangle UTF-8
            cmd.env("LANG", "en_US.UTF-8");
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Treeix");
        cmd.env("TREEIX_SESSION", &self.id);
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let pid = child.process_id().unwrap_or_default();

        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name(format!("pty-in-{}", self.id))
            .spawn(move || {
                for bytes in input_rx {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                }
            })?;
        *lock(&self.process) = Some(Process {
            master: pair.master,
            input,
            pid,
        });
        lock(&self.flow).closing = false;
        {
            let mut info = lock(&self.info);
            info.pid = Some(pid);
            info.status = SessionStatus::Running;
            info.exit_code = None;
        }

        let (tx, rx) = unbounded_channel();
        if restart {
            // Leave the old program's screen modes and start on a fresh line
            self.ingest(daemon, b"\x1b[?1049l\x1b[0m\x1b[?25h\r\n", &tx);
        }
        tokio::spawn(coalesce(self.clone(), daemon.clone(), rx));
        let (session, daemon) = (self.clone(), daemon.clone());
        std::thread::Builder::new()
            .name(format!("pty-out-{}", self.id))
            .spawn(move || session.read_loop(&daemon, reader, child, tx))?;
        Ok(())
    }

    fn read_loop(
        &self,
        daemon: &Daemon,
        mut reader: Box<dyn Read + Send>,
        mut child: Box<dyn Child + Send + Sync>,
        tx: UnboundedSender<Output>,
    ) {
        let mut buf = vec![0u8; READ_BUF];
        loop {
            self.wait_for_credit();
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => self.ingest(daemon, &buf[..n], &tx),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code() as i32);
        let _ = tx.send(Output::Exit(code));
    }

    fn wait_for_credit(&self) {
        let mut flow = lock(&self.flow);
        loop {
            let unacked = flow.clients.values().map(|c| c.unacked).max().unwrap_or(0);
            if flow.closing || unacked < LOW_WATER || (!flow.paused && unacked <= HIGH_WATER) {
                flow.paused = false;
                return;
            }
            flow.paused = true;
            flow = self.credit.wait(flow).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Parses output into the screen and queues it for attached clients
    fn ingest(&self, daemon: &Daemon, bytes: &[u8], tx: &UnboundedSender<Output>) {
        let mut found = Vec::new();
        let attached = {
            let mut vt = lock(&self.vt);
            let vt = &mut *vt;
            vt.parser.advance(&mut vt.term, bytes);
            vt.osc.scan(bytes, &mut found);
            let seq = vt.seq;
            vt.seq += bytes.len() as u64;
            self.seq.store(vt.seq, Ordering::Release);
            // Under the screen lock, so an Attach sees either this chunk in its snapshot or here
            let mut flow = lock(&self.flow);
            for client in flow.clients.values_mut() {
                client.unacked += bytes.len() as u64;
            }
            if !flow.clients.is_empty() {
                let _ = tx.send(Output::Data {
                    seq,
                    bytes: bytes.to_vec(),
                });
            }
            !flow.clients.is_empty()
        };
        self.dirty.store(true, Ordering::Relaxed);

        let events = std::mem::take(&mut *lock(&self.term_events));
        for event in events {
            match event {
                TermEvent::Title(title) => {
                    self.has_title.store(true, Ordering::Relaxed);
                    self.set_title(daemon, title);
                }
                TermEvent::ResetTitle => self.has_title.store(false, Ordering::Relaxed),
                TermEvent::Bell => daemon.broadcast(Event::Bell {
                    session: self.id.clone(),
                }),
                // An attached xterm.js answers terminal queries itself
                TermEvent::PtyWrite(reply) if !attached => self.write(reply.into_bytes()),
                _ => {}
            }
        }
        for osc in found {
            match osc {
                Osc::Cwd(cwd) => self.set_cwd(daemon, cwd),
                Osc::Notify { title, body } => daemon.broadcast(Event::Notify {
                    session: self.id.clone(),
                    title,
                    body,
                }),
            }
        }
    }

    fn set_title(&self, daemon: &Daemon, title: String) {
        let mut info = lock(&self.info);
        if info.title != title {
            info.title.clone_from(&title);
            drop(info);
            daemon.broadcast(Event::Title {
                session: self.id.clone(),
                title,
            });
            daemon.mark_state_dirty();
        }
    }

    fn set_cwd(&self, daemon: &Daemon, cwd: String) {
        let mut info = lock(&self.info);
        if info.cwd != cwd {
            info.cwd.clone_from(&cwd);
            drop(info);
            daemon.broadcast(Event::Cwd {
                session: self.id.clone(),
                cwd,
            });
            daemon.mark_state_dirty();
        }
    }

    /// Sends queued output to attached clients, trimming what their snapshot already had
    fn flush(&self, pending: &mut Pending) {
        if pending.bytes.is_empty() {
            return;
        }
        let flow = lock(&self.flow);
        for client in flow.clients.values() {
            let skip = client.from_seq.saturating_sub(pending.seq) as usize;
            if skip >= pending.bytes.len() {
                continue;
            }
            let mut seq = pending.seq + skip as u64;
            for chunk in pending.bytes[skip..].chunks(MAX_DATA_FRAME) {
                let data = Event::Data {
                    session: self.id.clone(),
                    seq,
                    bytes: chunk.to_vec(),
                };
                let _ = client.outbox.send(ServerMsg::Event(data));
                seq += chunk.len() as u64;
            }
        }
        pending.seq += pending.bytes.len() as u64;
        pending.bytes.clear();
    }

    fn exited(&self, daemon: &Daemon, code: Option<i32>) {
        lock(&self.process).take();
        if daemon.stopping() || !daemon.contains(&self.id) {
            return;
        }
        {
            let mut info = lock(&self.info);
            info.status = SessionStatus::Exited;
            info.exit_code = code;
            info.pid = None;
        }
        self.dirty.store(true, Ordering::Relaxed);
        daemon.broadcast(Event::Exit {
            session: self.id.clone(),
            code,
        });
        daemon.broadcast(Event::Status {
            session: self.id.clone(),
            status: SessionStatus::Exited,
        });
        daemon.mark_state_dirty();
    }

    /// Replies with the screen as ANSI and starts streaming Data from the same seq
    pub fn attach(&self, client: ClientId, outbox: &Outbox, req_id: u64) {
        let mut vt = lock(&self.vt);
        vt.settle();
        let snapshot = snapshot::serialize(&mut vt.term, ATTACH_HISTORY);
        let seq = vt.seq;
        let mut flow = lock(&self.flow);
        flow.clients.insert(
            client,
            Attached {
                from_seq: seq,
                unacked: 0,
                outbox: outbox.clone(),
            },
        );
        let mut info = lock(&self.info).clone();
        info.seq = seq;
        // Sent under the flow lock, so no Data for this client can overtake it
        let resp = Ok(Response::Attached {
            snapshot,
            seq,
            info,
        });
        let _ = outbox.send(ServerMsg::Resp { id: req_id, resp });
        drop(flow);
        self.credit.notify_all();
    }

    /// True when it was the last attached client
    pub fn detach(&self, client: ClientId) -> bool {
        let mut flow = lock(&self.flow);
        let removed = flow.clients.remove(&client).is_some();
        self.credit.notify_all();
        removed && flow.clients.is_empty()
    }

    pub fn ack(&self, client: ClientId, bytes: u64) {
        if let Some(c) = lock(&self.flow).clients.get_mut(&client) {
            c.unacked = c.unacked.saturating_sub(bytes);
        }
        self.credit.notify_all();
    }

    pub fn write(&self, bytes: Vec<u8>) {
        if let Some(process) = &*lock(&self.process) {
            let _ = process.input.send(bytes);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        if let Some(process) = &*lock(&self.process) {
            process.master.resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        lock(&self.vt).term.resize(size(cols, rows));
        let mut info = lock(&self.info);
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    /// SIGHUP to the process groups, SIGKILL after a grace period
    pub fn kill(self: &Arc<Self>) {
        let Some(pid) = self.signal(Signal::SIGHUP) else {
            return;
        };
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(KILL_GRACE).await;
            if lock(&session.process)
                .as_ref()
                .is_some_and(|p| p.pid == pid)
            {
                session.signal(Signal::SIGKILL);
            }
        });
    }

    /// Signals the session's group and the foreground job's group; returns the session pid
    pub fn signal(&self, signal: Signal) -> Option<u32> {
        let (pid, foreground) = {
            let process = lock(&self.process);
            let process = process.as_ref()?;
            (process.pid, process.master.process_group_leader())
        };
        {
            lock(&self.flow).closing = true;
            self.credit.notify_all();
        }
        let _ = killpg(Pid::from_raw(pid as i32), signal);
        if let Some(group) = foreground.filter(|&g| g > 0 && g != pid as i32) {
            let _ = killpg(Pid::from_raw(group), signal);
        }
        Some(pid)
    }

    /// Follows the foreground process: its cwd, and its name as the title when nothing set one
    pub fn poll_foreground(&self, daemon: &Daemon) {
        let foreground = {
            let process = lock(&self.process);
            let Some(process) = process.as_ref() else {
                return;
            };
            process
                .master
                .process_group_leader()
                .filter(|&g| g > 0)
                .unwrap_or(process.pid as i32)
        };
        if let Some(cwd) = procinfo::cwd(foreground) {
            self.set_cwd(daemon, cwd);
        }
        if !self.has_title.load(Ordering::Relaxed)
            && let Some(name) = procinfo::name(foreground)
        {
            self.set_title(daemon, name);
        }
    }

    /// The screen + scrollback as zstd ANSI, for `sessions/<id>.ansi.zst`
    pub fn snapshot(&self) -> Vec<u8> {
        let mut vt = lock(&self.vt);
        vt.settle();
        snapshot::serialize(&mut vt.term, HISTORY)
    }

    /// Paints a saved snapshot into the screen without counting it as output
    pub fn load_snapshot(&self, ansi: &[u8]) {
        let mut vt = lock(&self.vt);
        let vt = &mut *vt;
        vt.parser.advance(&mut vt.term, ansi);
        vt.settle();
        lock(&self.term_events).clear();
    }

    /// Marks a session from a previous daemon run that has no process
    pub fn set_status(&self, status: SessionStatus) {
        let mut info = lock(&self.info);
        info.status = status;
        info.pid = None;
    }
}

#[derive(Default)]
struct Pending {
    seq: u64,
    bytes: Vec<u8>,
}

impl Pending {
    /// Returns the exit code once the process has exited
    fn absorb(&mut self, output: Output) -> Option<Option<i32>> {
        match output {
            Output::Data { seq, bytes } => {
                if self.bytes.is_empty() {
                    self.seq = seq;
                }
                self.bytes.extend_from_slice(&bytes);
                None
            }
            Output::Exit(code) => Some(code),
        }
    }
}

/// Batches output per session: the first chunk after a quiet spell goes out at once (typing
/// latency), then at most one frame per COALESCE window unless a frame fills up
async fn coalesce(session: Arc<Session>, daemon: Arc<Daemon>, mut rx: UnboundedReceiver<Output>) {
    let mut pending = Pending::default();
    while let Some(output) = rx.recv().await {
        let mut exit = pending.absorb(output);
        while exit.is_none()
            && let Ok(output) = rx.try_recv()
        {
            exit = pending.absorb(output);
        }
        session.flush(&mut pending);
        let deadline = Instant::now() + COALESCE;
        while exit.is_none() && pending.bytes.len() < MAX_DATA_FRAME {
            tokio::select! {
                output = rx.recv() => match output {
                    Some(output) => exit = pending.absorb(output),
                    None => break,
                },
                () = sleep_until(deadline) => break,
            }
        }
        session.flush(&mut pending);
        if let Some(code) = exit {
            session.exited(&daemon, code);
            return;
        }
    }
}

fn login_shell() -> String {
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
