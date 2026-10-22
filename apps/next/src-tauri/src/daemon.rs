//! Client for `treeix-ptyd`: starts it when missing, replaces it on build skew, reconnects after it dies,
//! multiplexes requests by id and fans output of attached sessions out to every webview channel showing them.

use crate::types::{DaemonState, Frame, Hello, SessionEvent};
use std::collections::HashMap;
use std::io;
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
    streams: Mutex<Streams>,
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

    /// Every attach gets its own snapshot, even when another window already shows the session
    pub async fn attach(
        &self,
        session: SessionId,
        channel: Channel<Frame>,
    ) -> Result<Response, String> {
        let id = channel.id();
        self.streams.lock().unwrap().begin(&session, id);
        let resp = self
            .send(
                Request::Attach {
                    session: session.clone(),
                },
                Some((session.clone(), channel)),
            )
            .await;
        if !matches!(resp, Ok(Response::Attached { .. }))
            && self.streams.lock().unwrap().remove(&session, id)
        {
            self.detach_unwatched(session).await?;
        }
        resp
    }

    pub async fn detach(&self, session: SessionId, channel: u32) -> Result<(), String> {
        if self.streams.lock().unwrap().remove(&session, channel) {
            self.detach_unwatched(session).await?;
        }
        Ok(())
    }

    /// Detaches from the daemon unless a channel attached meanwhile. Checked under the writer lock, so an attach
    /// that registered after the check writes its request after this Detach
    async fn detach_unwatched(&self, session: SessionId) -> Result<(), String> {
        let mut writer = self.writer.lock().await;
        let Some(writer) = writer.as_mut() else {
            // Disconnected: the daemon dropped this connection's attaches with it
            return Ok(());
        };
        if self.streams.lock().unwrap().watched(&session) {
            return Ok(());
        }
        // Fire and forget: the reply resolves no pending request, and the reader may be the caller
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = Request::Detach { session };
        proto::write_frame(writer, &ClientMsg::Req { id, req })
            .await
            .map_err(|e| e.to_string())
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
                Ok(Some(ServerMsg::Resp { id, resp })) => {
                    if let Some(session) = self.resolve(id, resp) {
                        self.detach_quietly(session).await;
                    }
                }
                Ok(Some(ServerMsg::Event(Event::Data {
                    session,
                    seq,
                    bytes,
                }))) => {
                    if self.streams.lock().unwrap().relay(&session, seq, &bytes) {
                        self.detach_quietly(session).await;
                    }
                }
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

    async fn detach_quietly(&self, session: SessionId) {
        if let Err(e) = self.detach_unwatched(session).await {
            tracing::warn!("detach: {e}");
        }
    }

    /// Answers a request; returns a session to detach when its attach landed after every channel left
    fn resolve(&self, id: u64, mut resp: Result<Response, String>) -> Option<SessionId> {
        let pending = self.pending.lock().unwrap().remove(&id)?;
        let mut unwatched = None;
        if let (Some((session, channel)), Ok(Response::Attached { snapshot, seq, .. })) =
            (pending.stream, &mut resp)
        {
            let snapshot = Frame::snapshot(*seq, &std::mem::take(snapshot));
            if self
                .streams
                .lock()
                .unwrap()
                .ready(&session, channel, snapshot)
            {
                unwatched = Some(session);
            }
        }
        let _ = pending.reply.send(resp);
        unwatched
    }
}

/// The webview channels of each session this connection is attached to. The daemon streams a session once per
/// connection; every channel gets each chunk and drops what its own snapshot already covered (stream.ts bytesFrom).
/// Mutations return true when the session just lost its last channel, so the daemon attach should go too
#[derive(Default)]
struct Streams(HashMap<SessionId, Vec<Stream>>);

struct Stream {
    id: u32,
    /// None until the attach answers; a pending attach still counts as watching
    channel: Option<Channel<Frame>>,
}

impl Streams {
    fn begin(&mut self, session: &SessionId, id: u32) {
        let streams = self.0.entry(session.clone()).or_default();
        if !streams.iter().any(|s| s.id == id) {
            streams.push(Stream { id, channel: None });
        }
    }

    /// Sends the snapshot first, then the channel joins the fan-out. Lost when it was detached meanwhile
    fn ready(&mut self, session: &SessionId, channel: Channel<Frame>, snapshot: Frame) -> bool {
        let id = channel.id();
        let Some(stream) = self
            .0
            .get_mut(session)
            .and_then(|streams| streams.iter_mut().find(|s| s.id == id))
        else {
            return !self.watched(session);
        };
        if channel.send(snapshot).is_err() {
            return self.remove(session, id);
        }
        stream.channel = Some(channel);
        false
    }

    fn remove(&mut self, session: &SessionId, id: u32) -> bool {
        let Some(streams) = self.0.get_mut(session) else {
            return false;
        };
        let before = streams.len();
        streams.retain(|s| s.id != id);
        let removed = streams.len() < before;
        if streams.is_empty() {
            self.0.remove(session);
        }
        removed && !self.watched(session)
    }

    /// A reloaded webview drops its channels; the session keeps running and its panes attach again
    fn relay(&mut self, session: &SessionId, seq: u64, bytes: &[u8]) -> bool {
        let Some(streams) = self.0.get_mut(session) else {
            return false;
        };
        streams.retain(|s| match &s.channel {
            Some(channel) => channel.send(Frame::data(seq, bytes)).is_ok(),
            None => true,
        });
        if !streams.is_empty() {
            return false;
        }
        self.0.remove(session);
        true
    }

    fn watched(&self, session: &SessionId) -> bool {
        self.0.contains_key(session)
    }

    fn clear(&mut self) {
        self.0.clear();
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
    // launchctl and systemctl block; keep them off the runtime's threads
    tokio::task::spawn_blocking(crate::service::start)
        .await
        .map_err(io::Error::other)??;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    type Seen = Arc<Mutex<Vec<Vec<u8>>>>;

    fn channel() -> (Channel<Frame>, Seen) {
        let seen = Seen::default();
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        (channel, seen)
    }

    fn raw(frame: Frame) -> Vec<u8> {
        match frame.body().unwrap() {
            InvokeResponseBody::Raw(bytes) => bytes,
            InvokeResponseBody::Json(_) => unreachable!(),
        }
    }

    fn closed() -> Channel<Frame> {
        Channel::new(|_| Err(tauri::Error::WindowNotFound))
    }

    fn attach(streams: &mut Streams, session: &SessionId, channel: Channel<Frame>, seq: u64) {
        streams.begin(session, channel.id());
        assert!(!streams.ready(session, channel, Frame::snapshot(seq, b"screen")));
    }

    #[test]
    fn every_channel_gets_its_snapshot_then_the_shared_output() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (main, main_seen) = channel();
        let (quick, quick_seen) = channel();
        attach(&mut streams, &s, main, 10);
        assert!(!streams.relay(&s, 10, b"one"));
        attach(&mut streams, &s, quick, 13);
        assert!(!streams.relay(&s, 13, b"two"));
        assert_eq!(
            *main_seen.lock().unwrap(),
            [
                raw(Frame::snapshot(10, b"screen")),
                raw(Frame::data(10, b"one")),
                raw(Frame::data(13, b"two"))
            ]
        );
        assert_eq!(
            *quick_seen.lock().unwrap(),
            [
                raw(Frame::snapshot(13, b"screen")),
                raw(Frame::data(13, b"two"))
            ]
        );
    }

    #[test]
    fn only_the_last_channel_leaving_detaches_the_session() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (main, _) = channel();
        let (quick, _) = channel();
        let (main_id, quick_id) = (main.id(), quick.id());
        attach(&mut streams, &s, main, 0);
        attach(&mut streams, &s, quick, 0);
        assert!(!streams.remove(&s, main_id));
        assert!(!streams.remove(&s, main_id), "a repeated detach is a no-op");
        assert!(streams.remove(&s, quick_id));
        assert!(!streams.watched(&s));
        assert!(!streams.remove(&s, quick_id));
    }

    #[test]
    fn a_pending_attach_keeps_the_session_attached() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (old, _) = channel();
        let (new, new_seen) = channel();
        let old_id = old.id();
        attach(&mut streams, &s, old, 0);
        streams.begin(&s, new.id());
        // A pane shown again attaches its new channel before the old one's detach lands
        assert!(!streams.remove(&s, old_id));
        assert!(!streams.relay(&s, 0, b"x"), "pending channels get no data");
        assert!(!streams.ready(&s, new, Frame::snapshot(1, b"")));
        assert!(!streams.relay(&s, 1, b"y"));
        assert_eq!(new_seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn an_attach_answered_after_its_detach_is_dropped() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (late, seen) = channel();
        streams.begin(&s, late.id());
        assert!(streams.remove(&s, late.id()));
        assert!(streams.ready(&s, late, Frame::snapshot(0, b"")));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn closed_channels_drop_out_and_the_last_one_detaches() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (live, seen) = channel();
        attach(&mut streams, &s, live, 0);
        streams.begin(&s, 999);
        let dead = closed();
        streams.begin(&s, dead.id());
        assert!(!streams.ready(&s, dead, Frame::snapshot(0, b"")));
        assert!(!streams.relay(&s, 0, b"x"));
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert!(!streams.remove(&s, 999));

        let mut streams = Streams::default();
        let dead = closed();
        let id = dead.id();
        streams.begin(&s, id);
        streams.0.get_mut(&s).unwrap()[0].channel = Some(dead);
        assert!(streams.relay(&s, 0, b"x"));
        assert!(!streams.watched(&s));
    }
}
