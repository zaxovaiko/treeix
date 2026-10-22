//! The real `treeix-ptyd` binary in its own process: signals, crashes, upgrades, memory.

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use tokio::net::UnixStream;
use treeix_proto::{
    ClientMsg, CreateSession, Event, PROTO_VERSION, Request, Response, ServerMsg, SessionInfo,
    SessionKind, SessionStatus, read_frame, write_frame,
};
use treeix_ptyd::client::Client;

/// Kills the daemon when a test fails half way
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Daemon {
    fn pid(&self) -> Pid {
        Pid::from_raw(self.0.id() as i32)
    }

    fn signal(&self, signal: Signal) {
        kill(self.pid(), signal).unwrap();
    }

    /// Waits up to `limit` for the process to exit
    fn exited_within(&mut self, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if self.0.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

fn spawn(dir: &Path) -> Daemon {
    Daemon(
        Command::new(env!("CARGO_BIN_EXE_treeix-ptyd"))
            .env("TREEIX_DATA_DIR", dir)
            .spawn()
            .unwrap(),
    )
}

async fn start(dir: &Path) -> (Daemon, Client) {
    let daemon = spawn(dir);
    let start = Instant::now();
    loop {
        if let Ok(client) = Client::connect(&dir.join("ptyd.sock")).await {
            assert_eq!(client.pid, daemon.0.id());
            return (daemon, client);
        }
        assert!(start.elapsed() < Duration::from_secs(5), "daemon came up");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn create(command: &[&str]) -> Request {
    Request::Create(CreateSession {
        kind: SessionKind::Shell,
        cwd: None,
        command: command.iter().map(|s| s.to_string()).collect(),
        env: vec![],
        cols: 80,
        rows: 24,
        title: None,
        routine: None,
    })
}

async fn created(client: &mut Client, command: &[&str]) -> SessionInfo {
    match client.request(create(command)).await.unwrap() {
        Response::Created(info) => info,
        other => panic!("{other:?}"),
    }
}

async fn list(client: &mut Client) -> Vec<SessionInfo> {
    match client.request(Request::List).await.unwrap() {
        Response::Sessions(list) => list,
        other => panic!("{other:?}"),
    }
}

fn state(dir: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap()
}

fn alive(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_ok()
}

async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn other_build_does_not_stop_the_daemon_until_it_sends_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let (mut daemon, mut client) = start(dir.path()).await;
    let info = created(&mut client, &["sh", "-c", "echo kept; sleep 100"]).await;

    let (mut reader, mut writer) = UnixStream::connect(dir.path().join("ptyd.sock"))
        .await
        .unwrap()
        .into_split();
    let hello = ClientMsg::Hello {
        proto: PROTO_VERSION + 1,
        build: "older-or-newer".into(),
    };
    write_frame(&mut writer, &hello).await.unwrap();
    let Some(ServerMsg::Hello { build, pid, .. }) = read_frame(&mut reader).await.unwrap() else {
        panic!("no Hello");
    };
    assert_eq!((build.as_str(), pid), (treeix_ptyd::BUILD, daemon.0.id()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(daemon.0.try_wait().unwrap().is_none(), "still serving");
    assert_eq!(list(&mut client).await[0].status, SessionStatus::Running);

    // The app saw the skew and replaces the daemon
    let shutdown = ClientMsg::Req {
        id: 0,
        req: Request::Shutdown,
    };
    write_frame(&mut writer, &shutdown).await.unwrap();
    loop {
        match read_frame::<_, ServerMsg>(&mut reader).await {
            Ok(Some(ServerMsg::Resp { id: 0, resp })) => assert_eq!(resp, Ok(Response::Ok)),
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    assert!(daemon.exited_within(Duration::from_secs(2)));
    let state = state(dir.path());
    assert_eq!(state["clean_shutdown"], true);
    assert_eq!(state["sessions"][0]["info"]["id"], info.id.as_str());
    assert!(
        dir.path()
            .join(format!("sessions/{}.ansi.zst", info.id))
            .exists()
    );
}

#[tokio::test]
async fn sigterm_with_live_sessions_exits_within_two_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let (mut daemon, mut client) = start(dir.path()).await;
    let shell = created(&mut client, &[]).await;
    created(&mut client, &["sh", "-c", "yes"]).await;
    // An attached client that never acks keeps the reader of `yes` parked on flow control
    client
        .request(Request::Attach {
            session: shell.id.clone(),
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    daemon.signal(Signal::SIGTERM);
    assert!(
        daemon.exited_within(Duration::from_secs(2)),
        "alive 2 s after SIGTERM"
    );
    let state = state(dir.path());
    assert_eq!(state["clean_shutdown"], true);
    assert_eq!(state["sessions"].as_array().unwrap().len(), 2);
    assert!(!dir.path().join("ptyd.sock").exists());
}

#[tokio::test]
async fn sigkill_leaves_crashed_sessions_and_the_next_daemon_reaps_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let (mut daemon, mut client) = start(dir.path()).await;
    // Ignores the hangup the kernel sends when the dead daemon's PTY closes, like nohup'd jobs do
    let script = "trap '' HUP; echo before crash; sleep 1000 & echo bg=$!; wait";
    let info = created(&mut client, &["sh", "-c", script]).await;
    let shell = info.pid.unwrap() as i32;
    client
        .request(Request::Attach {
            session: info.id.clone(),
        })
        .await
        .unwrap();
    let mut out = String::new();
    let grandchild: i32 = loop {
        if let Some(Event::Data { bytes, .. }) = client.next_event().await.unwrap() {
            out.push_str(&String::from_utf8_lossy(&bytes));
        }
        if let Some((pid, _)) = out.split_once("bg=").and_then(|(_, r)| r.split_once('\r')) {
            break pid.parse().unwrap();
        }
    };
    // Detaching snapshots the scrollback; the debounced state.json write records the start time
    client
        .request(Request::Detach {
            session: info.id.clone(),
        })
        .await
        .unwrap();
    let snapshot = dir.path().join(format!("sessions/{}.ansi.zst", info.id));
    eventually("snapshot and state written", || {
        snapshot.exists() && state(dir.path())["sessions"][0]["started"].is_u64()
    })
    .await;

    daemon.signal(Signal::SIGKILL);
    assert!(daemon.exited_within(Duration::from_secs(2)));
    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        alive(shell) && alive(grandchild),
        "orphans outlived the daemon"
    );

    let (_daemon, mut client) = start(dir.path()).await;
    let crashed = list(&mut client).await.remove(0);
    assert_eq!(
        (crashed.id.as_str(), crashed.status, crashed.pid),
        (info.id.as_str(), SessionStatus::Crashed, None)
    );
    match client
        .request(Request::Attach {
            session: info.id.clone(),
        })
        .await
        .unwrap()
    {
        Response::Attached { snapshot, .. } => {
            assert!(String::from_utf8_lossy(&snapshot).contains("before crash"))
        }
        other => panic!("{other:?}"),
    }
    eventually("orphans reaped", || !alive(shell) && !alive(grandchild)).await;
    client.request(Request::Shutdown).await.unwrap();
}

#[tokio::test]
async fn one_daemon_per_data_dir_even_without_its_socket() {
    let dir = tempfile::tempdir().unwrap();
    let (mut first, mut client) = start(dir.path()).await;
    std::fs::remove_file(dir.path().join("ptyd.sock")).unwrap();
    let mut second = spawn(dir.path());
    assert!(second.exited_within(Duration::from_secs(5)));
    assert!(second.0.try_wait().unwrap().unwrap().success());
    assert!(!dir.path().join("ptyd.sock").exists());
    assert!(first.0.try_wait().unwrap().is_none());
    assert!(list(&mut client).await.is_empty(), "first still serves");
    client.request(Request::Shutdown).await.unwrap();
    assert!(first.exited_within(Duration::from_secs(2)));
}

#[tokio::test]
async fn twenty_idle_shells_stay_under_64_mb() {
    let dir = tempfile::tempdir().unwrap();
    let (daemon, mut client) = start(dir.path()).await;
    for _ in 0..20 {
        created(&mut client, &[]).await;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    let ps = Command::new("ps")
        .args(["-o", "rss=", "-p", &daemon.0.id().to_string()])
        .output()
        .unwrap();
    let mb = String::from_utf8_lossy(&ps.stdout)
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.0;
    assert!(mb < 64.0, "daemon RSS {mb:.1} MB with 20 idle shells");
    client.request(Request::Shutdown).await.unwrap();
}
