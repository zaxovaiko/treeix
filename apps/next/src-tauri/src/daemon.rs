//! Client for `treeix-ptyd`: starts it when missing, replaces it on build skew, reconnects after it dies,
//! multiplexes requests by id and relays output of attached sessions to their webview channel.

use crate::types::{DaemonState, Frame, Hello, SessionEvent};
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{oneshot, watch};
use tokio::time::{sleep, timeout};
use treeix_proto::{self as proto, ClientMsg, Event, Request, Response, ServerMsg, SessionId};

pub const BUILD: &str = match option_env!("TREEIX_BUILD") {
    Some(build) => build,
    None => env!("CARGO_PKG_VERSION"),
};
#[cfg(target_os = "macos")]
const LAUNCH_AGENT_PLIST: &str = "com.dyvertex.treeix.next.ptyd.plist";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

type Reply = oneshot::Sender<Result<Response, String>>;

struct Pending {
    reply: Reply,
    /// Set for Attach: the snapshot goes out on it before any Data, from the reader task
    stream: Option<(SessionId, Channel<Frame>)>,
}

#[derive(Default)]
pub struct Daemon {
    writer: tokio::sync::Mutex<Option<OwnedWriteHalf>>,
    pending: Mutex<HashMap<u64, Pending>>,
    streams: Mutex<HashMap<SessionId, Channel<Frame>>>,
    /// Channel of the newest attach per session. A pane hidden and shown again detaches its old channel
    /// asynchronously; that detach must not undo the newer attach
    latest: Mutex<HashMap<SessionId, u32>>,
    next_id: AtomicU64,
    hello: watch::Sender<Option<Hello>>,
}

impl Daemon {
    pub async fn hello(&self) -> Result<Hello, String> {
        let mut rx = self.hello.subscribe();
        let hello = timeout(REQUEST_TIMEOUT, rx.wait_for(Option::is_some))
            .await
            .map_err(|_| "daemon not reachable".to_string())?
            .map_err(|e| e.to_string())?;
        Ok(hello.clone().expect("waited for Some"))
    }

    pub async fn request(&self, req: Request) -> Result<Response, String> {
        self.send(req, None).await
    }

    pub async fn attach(
        &self,
        session: SessionId,
        channel: Channel<Frame>,
    ) -> Result<Response, String> {
        self.latest
            .lock()
            .unwrap()
            .insert(session.clone(), channel.id());
        self.send(
            Request::Attach {
                session: session.clone(),
            },
            Some((session, channel)),
        )
        .await
    }

    pub async fn detach(&self, session: SessionId, channel: u32) -> Result<Response, String> {
        {
            let mut latest = self.latest.lock().unwrap();
            if latest.get(&session) != Some(&channel) {
                return Ok(Response::Ok);
            }
            latest.remove(&session);
        }
        self.streams.lock().unwrap().remove(&session);
        self.request(Request::Detach { session }).await
    }

    async fn send(
        &self,
        req: Request,
        stream: Option<(SessionId, Channel<Frame>)>,
    ) -> Result<Response, String> {
        self.hello().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id, Pending { reply, stream });
        let written = match self.writer.lock().await.as_mut() {
            Some(writer) => proto::write_frame(writer, &ClientMsg::Req { id, req })
                .await
                .map_err(|e| e.to_string()),
            None => Err("daemon disconnected".into()),
        };
        if let Err(e) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| "daemon did not answer".to_string())?
            .map_err(|_| "daemon disconnected".to_string())?
    }

    pub async fn run(self: Arc<Self>, app: AppHandle) {
        let mut backoff = Duration::from_millis(100);
        loop {
            match connect().await {
                Ok((reader, writer, hello)) => {
                    backoff = Duration::from_millis(100);
                    tracing::info!(pid = hello.daemon_pid, build = %hello.build, "daemon connected");
                    *self.writer.lock().await = Some(writer);
                    self.hello.send_replace(Some(hello));
                    emit(
                        &app,
                        SessionEvent::Daemon {
                            state: DaemonState::Connected,
                        },
                    );
                    self.read(reader, &app).await;
                    tracing::warn!("daemon disconnected");
                    self.hello.send_replace(None);
                    *self.writer.lock().await = None;
                    self.pending.lock().unwrap().clear();
                    self.streams.lock().unwrap().clear();
                    self.latest.lock().unwrap().clear();
                    emit(
                        &app,
                        SessionEvent::Daemon {
                            state: DaemonState::Disconnected,
                        },
                    );
                }
                Err(e) => {
                    tracing::error!("daemon unavailable: {e}");
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                }
            }
        }
    }

    async fn read(&self, mut reader: OwnedReadHalf, app: &AppHandle) {
        loop {
            match proto::read_frame::<_, ServerMsg>(&mut reader).await {
                Ok(Some(ServerMsg::Resp { id, resp })) => self.resolve(id, resp),
                Ok(Some(ServerMsg::Event(Event::Data {
                    session,
                    seq,
                    bytes,
                }))) => self.relay(session, seq, &bytes),
                Ok(Some(ServerMsg::Event(event))) => {
                    if let Some(event) = SessionEvent::from_proto(event) {
                        emit(app, event);
                    }
                }
                Ok(Some(ServerMsg::Hello { .. })) => {}
                Ok(None) => return,
                Err(e) => {
                    tracing::error!("daemon stream: {e}");
                    return;
                }
            }
        }
    }

    fn resolve(&self, id: u64, mut resp: Result<Response, String>) {
        let Some(pending) = self.pending.lock().unwrap().remove(&id) else {
            return;
        };
        if let (Some((session, channel)), Ok(Response::Attached { snapshot, seq, .. })) =
            (pending.stream, &mut resp)
        {
            let snapshot = std::mem::take(snapshot);
            if channel.send(Frame::snapshot(*seq, &snapshot)).is_ok() {
                self.streams.lock().unwrap().insert(session, channel);
            }
        }
        let _ = pending.reply.send(resp);
    }

    fn relay(&self, session: SessionId, seq: u64, bytes: &[u8]) {
        let mut streams = self.streams.lock().unwrap();
        let Some(channel) = streams.get(&session) else {
            return;
        };
        // A reloaded webview drops its channels; the session keeps running and the next attach replaces it
        if channel.send(Frame::data(seq, bytes)).is_err() {
            streams.remove(&session);
        }
    }
}

fn emit(app: &AppHandle, event: SessionEvent) {
    if let Err(e) = app.emit("session-event", event) {
        tracing::error!("emit session-event: {e}");
    }
}

type Connection = (OwnedReadHalf, OwnedWriteHalf, Hello);

async fn connect() -> io::Result<Connection> {
    if let Ok((mut reader, mut writer, hello)) = handshake().await {
        if is_ours(&hello) {
            return Ok((reader, writer, hello));
        }
        tracing::info!(theirs = %hello.build, ours = BUILD, "daemon build differs, replacing it");
        proto::write_frame(
            &mut writer,
            &ClientMsg::Req {
                id: 0,
                req: Request::Shutdown,
            },
        )
        .await?;
        // The daemon snapshots its sessions before it closes the socket
        let exited = timeout(Duration::from_secs(10), async {
            while let Ok(Some(_)) = proto::read_frame::<_, ServerMsg>(&mut reader).await {}
        });
        if exited.await.is_err() {
            return Err(io::Error::other("old daemon did not exit"));
        }
    }
    start()?;
    let mut last = io::Error::other("daemon did not come up");
    for _ in 0..50 {
        sleep(Duration::from_millis(100)).await;
        match handshake().await {
            Ok(conn) if is_ours(&conn.2) => return Ok(conn),
            Ok(conn) => {
                last = io::Error::other(format!("daemon build {} is not {BUILD}", conn.2.build))
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn is_ours(hello: &Hello) -> bool {
    hello.proto == proto::PROTO_VERSION && hello.build == BUILD
}

async fn handshake() -> io::Result<Connection> {
    let (mut reader, mut writer) = UnixStream::connect(proto::socket_path())
        .await?
        .into_split();
    proto::write_frame(
        &mut writer,
        &ClientMsg::Hello {
            proto: proto::PROTO_VERSION,
            build: BUILD.into(),
        },
    )
    .await?;
    match timeout(
        Duration::from_secs(3),
        proto::read_frame::<_, ServerMsg>(&mut reader),
    )
    .await
    {
        Ok(Ok(Some(ServerMsg::Hello { proto, build, pid }))) => Ok((
            reader,
            writer,
            Hello {
                proto,
                build,
                daemon_pid: pid,
            },
        )),
        Ok(Err(e)) => Err(e),
        Ok(_) => Err(io::Error::other("daemon sent no hello")),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "daemon hello timed out",
        )),
    }
}

/// Tauri puts the sidecar next to the app binary, in the bundle and in dev
fn sidecar() -> io::Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name("treeix-ptyd"))
}

fn start() -> io::Result<()> {
    let sidecar = sidecar()?;
    #[cfg(target_os = "macos")]
    if register_launch_agent(&sidecar) {
        return Ok(());
    }
    spawn_detached(&sidecar)
}

/// launchd keeps the daemon alive across app quits and crashes. Only from an installed bundle with the default
/// data dir: a LaunchAgent cannot see `TREEIX_DATA_DIR`, and dev builds must not leave one registered
#[cfg(target_os = "macos")]
fn register_launch_agent(sidecar: &std::path::Path) -> bool {
    use smappservice_rs::{AppService, ServiceStatus, ServiceType};
    let bundled = sidecar.to_string_lossy().contains(".app/Contents/MacOS/");
    if !bundled || std::env::var_os("TREEIX_DATA_DIR").is_some() {
        return false;
    }
    let service = AppService::new(ServiceType::Agent {
        plist_name: LAUNCH_AGENT_PLIST,
    });
    if service.status() == ServiceStatus::Enabled {
        // Registered but not answering: launchd gave up on it, so run one by hand
        return false;
    }
    match service.register() {
        Ok(()) => service.status() == ServiceStatus::Enabled,
        Err(e) => {
            tracing::warn!("launch agent registration failed, spawning the daemon: {e}");
            false
        }
    }
}

fn spawn_detached(sidecar: &std::path::Path) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = Command::new(sidecar);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe; the daemon leaves our session so it outlives the app and its terminal
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    tracing::info!(pid = child.id(), "spawned daemon {}", sidecar.display());
    std::thread::spawn(move || child.wait());
    Ok(())
}
