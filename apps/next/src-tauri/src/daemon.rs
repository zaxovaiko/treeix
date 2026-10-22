//! Client for `treeix-ptyd`: starts it when missing, replaces it on build skew, reconnects after it dies,
//! multiplexes requests by id and relays each webview channel's stream. Every channel is its own attach in ptyd, with
//! its own flow control: a channel that falls behind gets a resync of the screen while the others stay live.

use crate::types::{DaemonState, Frame, Hello, SessionEvent};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Webview};
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
    /// Set for an attach: the snapshot goes out on it before any data, from the reader task. Taken when its
    /// webview reloads meanwhile
    stream: Option<(SessionId, Stream)>,
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

    pub async fn attach(
        &self,
        session: SessionId,
        webview: String,
        channel: Channel<Frame>,
    ) -> Result<Response, String> {
        let req = Request::AttachChannel {
            session: session.clone(),
            channel: channel.id(),
        };
        self.send(req, Some((session, Stream { webview, channel })))
            .await
    }

    pub async fn detach(&self, session: SessionId, channel: u32) -> Result<(), String> {
        self.streams
            .lock()
            .unwrap()
            .0
            .remove(&(session.clone(), channel));
        self.detach_channel(session, channel).await
    }

    /// A reloaded webview's channels never ack again; ptyd would hold their sessions' output for them
    pub fn drop_webview(self: &Arc<Self>, label: &str) {
        for pending in self.pending.lock().unwrap().values_mut() {
            if pending
                .stream
                .as_ref()
                .is_some_and(|(_, s)| s.webview == label)
            {
                pending.stream = None;
            }
        }
        let dropped = self.streams.lock().unwrap().drop_webview(label);
        let daemon = self.clone();
        let label = label.to_owned();
        tauri::async_runtime::spawn(async move {
            for (session, channel) in dropped {
                daemon.detach_quietly(session, channel).await;
            }
            crate::commands::drop_webview_chats(&daemon, &label).await;
        });
    }

    /// Fire and forget: the reply resolves no pending request, and the reader may be the caller
    async fn detach_channel(&self, session: SessionId, channel: u32) -> Result<(), String> {
        let mut writer = self.writer.lock().await;
        let Some(writer) = writer.as_mut() else {
            // Disconnected: the daemon dropped this connection's attaches with it
            return Ok(());
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = Request::DetachChannel { session, channel };
        proto::write_frame(writer, &ClientMsg::Req { id, req })
            .await
            .map_err(|e| e.to_string())
    }

    async fn send(
        &self,
        req: Request,
        stream: Option<(SessionId, Stream)>,
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
                    let daemon = self.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::commands::reattach_chats(&daemon).await
                    });
                    self.read(reader, &app).await;
                    tracing::warn!("daemon disconnected");
                    self.hello.send_replace(None);
                    *self.writer.lock().await = None;
                    self.pending.lock().unwrap().clear();
                    self.streams.lock().unwrap().0.clear();
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
                Ok(Some(ServerMsg::Event(Event::ChannelData {
                    session,
                    channel,
                    seq,
                    bytes,
                }))) => self.relay(session, channel, Frame::data(seq, &bytes)).await,
                Ok(Some(ServerMsg::Event(Event::Resync {
                    session,
                    channel: Some(channel),
                    seq,
                    snapshot,
                }))) => {
                    self.relay(session, channel, Frame::resync(seq, &snapshot))
                        .await
                }
                Ok(Some(ServerMsg::Event(
                    event
                    @ (Event::Chat { .. } | Event::ChatChanged(_) | Event::ChatRemoved { .. }),
                ))) => crate::commands::on_chat_event(app, event),
                Ok(Some(ServerMsg::Event(event))) => {
                    if let Some(event) = SessionEvent::from_proto(event) {
                        crate::commands::on_session_event(app, &event);
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

    /// Output for a channel nobody shows (closed, reloaded, attached during a reload) detaches it
    async fn relay(&self, session: SessionId, channel: u32, frame: Frame) {
        if !self.streams.lock().unwrap().send(&session, channel, frame) {
            self.detach_quietly(session, channel).await;
        }
    }

    async fn detach_quietly(&self, session: SessionId, channel: u32) {
        if let Err(e) = self.detach_channel(session, channel).await {
            tracing::warn!("detach: {e}");
        }
    }

    /// Answers a request; an attach's channel gets its snapshot and joins the relay first
    fn resolve(&self, id: u64, mut resp: Result<Response, String>) {
        let Some(pending) = self.pending.lock().unwrap().remove(&id) else {
            return;
        };
        if let (Some((session, stream)), Ok(Response::Attached { snapshot, seq, .. })) =
            (pending.stream, &mut resp)
        {
            // A closed channel is detached by the relay when its first data comes
            let snapshot = Frame::snapshot(*seq, &std::mem::take(snapshot));
            if stream.channel.send(snapshot).is_ok() {
                let key = (session, stream.channel.id());
                self.streams.lock().unwrap().0.insert(key, stream);
            }
        }
        let _ = pending.reply.send(resp);
    }
}

/// The webview channel of each AttachChannel on this connection, by session and channel id
#[derive(Default)]
struct Streams(HashMap<(SessionId, u32), Stream>);

struct Stream {
    /// Label of the webview that owns the channel
    webview: String,
    channel: Channel<Frame>,
}

impl Streams {
    /// False when no channel took it; a channel that fails to send is dropped
    fn send(&mut self, session: &SessionId, channel: u32, frame: Frame) -> bool {
        let key = (session.clone(), channel);
        let Some(stream) = self.0.get(&key) else {
            return false;
        };
        if stream.channel.send(frame).is_err() {
            self.0.remove(&key);
            return false;
        }
        true
    }

    fn drop_webview(&mut self, label: &str) -> Vec<(SessionId, u32)> {
        let keys: Vec<_> = self
            .0
            .iter()
            .filter(|(_, s)| s.webview == label)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &keys {
            self.0.remove(key);
        }
        keys
    }
}

/// A webview starting a page load (reload, dev HMR full reload) has dropped its channels
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Started
        && let Some(daemon) = webview.try_state::<Arc<Daemon>>()
    {
        daemon.drop_webview(webview.label());
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

    fn stream(webview: &str, channel: Channel<Frame>) -> Stream {
        Stream {
            webview: webview.into(),
            channel,
        }
    }

    #[test]
    fn each_channel_gets_only_its_own_frames() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let (main, main_seen) = channel();
        let (quick, quick_seen) = channel();
        let (main_id, quick_id) = (main.id(), quick.id());
        streams.0.insert((s.clone(), main_id), stream("main", main));
        streams
            .0
            .insert((s.clone(), quick_id), stream("quick", quick));
        assert!(streams.send(&s, main_id, Frame::data(10, b"one")));
        assert!(streams.send(&s, quick_id, Frame::resync(13, b"screen")));
        assert!(
            !streams.send(&s, 999, Frame::data(0, b"x")),
            "unknown channel"
        );
        assert!(!streams.send(&"b".into(), main_id, Frame::data(0, b"x")));
        assert_eq!(*main_seen.lock().unwrap(), [raw(Frame::data(10, b"one"))]);
        assert_eq!(
            *quick_seen.lock().unwrap(),
            [raw(Frame::resync(13, b"screen"))]
        );
    }

    #[test]
    fn closed_channels_drop_out() {
        let s = "a".to_string();
        let mut streams = Streams::default();
        let dead = closed();
        let id = dead.id();
        streams.0.insert((s.clone(), id), stream("main", dead));
        assert!(!streams.send(&s, id, Frame::data(0, b"x")));
        assert!(streams.0.is_empty());
    }

    #[test]
    fn a_reloaded_webview_drops_only_its_channels() {
        let mut streams = Streams::default();
        let (main, _) = channel();
        let (quick, quick_seen) = channel();
        let (main_id, quick_id) = (main.id(), quick.id());
        streams
            .0
            .insert(("a".into(), main_id), stream("main", main));
        streams
            .0
            .insert(("a".into(), quick_id), stream("quick", quick));
        assert_eq!(streams.drop_webview("main"), [("a".into(), main_id)]);
        assert!(!streams.send(&"a".into(), main_id, Frame::data(0, b"x")));
        assert!(streams.send(&"a".into(), quick_id, Frame::data(0, b"x")));
        assert_eq!(quick_seen.lock().unwrap().len(), 1);
    }
}
