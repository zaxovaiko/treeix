use std::path::Path;
use std::time::{Duration, Instant};
use treeix_proto::{
    CreateSession, Event, Request, Response, SessionInfo, SessionKind, SessionStatus,
};
use treeix_ptyd::client::Client;

async fn connect(dir: &Path) -> Client {
    Client::connect(&dir.join("ptyd.sock"))
        .await
        .expect("connect")
}

fn create(command: &str) -> Request {
    Request::Create(CreateSession {
        kind: SessionKind::Shell,
        cwd: None,
        command: vec!["sh".into(), "-c".into(), command.into()],
        env: vec![],
        cols: 80,
        rows: 24,
        title: None,
        routine: None,
    })
}

async fn created(client: &mut Client, command: &str) -> SessionInfo {
    match client.request(create(command)).await.unwrap() {
        Response::Created(info) => info,
        other => panic!("{other:?}"),
    }
}

async fn attach(client: &mut Client, session: &str) -> (Vec<u8>, u64, SessionInfo) {
    match client
        .request(Request::Attach {
            session: session.into(),
        })
        .await
        .unwrap()
    {
        Response::Attached {
            snapshot,
            seq,
            info,
        } => (snapshot, seq, info),
        other => panic!("{other:?}"),
    }
}

async fn list(client: &mut Client) -> Vec<SessionInfo> {
    match client.request(Request::List).await.unwrap() {
        Response::Sessions(list) => list,
        other => panic!("{other:?}"),
    }
}

async fn wait_for_info(
    client: &mut Client,
    session: &str,
    done: impl Fn(&SessionInfo) -> bool,
) -> SessionInfo {
    let start = Instant::now();
    loop {
        if let Some(info) = list(client)
            .await
            .into_iter()
            .find(|s| s.id == session && done(s))
        {
            return info;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting on {session}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Data of `session` from `seq` on, checking it is contiguous, until it exits
async fn output_until_exit(
    client: &mut Client,
    session: &str,
    mut seq: u64,
) -> (Vec<u8>, Option<i32>) {
    let mut out = Vec::new();
    loop {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Data {
                session: s,
                seq: at,
                bytes,
            } if s == session => {
                assert_eq!(at, seq, "Data is contiguous");
                seq += bytes.len() as u64;
                out.extend_from_slice(&bytes);
            }
            Event::Exit { session: s, code } if s == session => return (out, code),
            _ => {}
        }
    }
}

fn rss_bytes() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .unwrap()
        * 1024
}

#[tokio::test]
async fn printf_bytes_and_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let info = created(
        &mut client,
        r"sleep 0.3; printf 'hello \033[31mred\033[0m'; exit 3",
    )
    .await;
    let (_, seq, _) = attach(&mut client, &info.id).await;
    assert_eq!(seq, 0);
    let (out, code) = output_until_exit(&mut client, &info.id, seq).await;
    assert_eq!(out, b"hello \x1b[31mred\x1b[0m");
    assert_eq!(code, Some(3));
    let info = wait_for_info(&mut client, &info.id, |s| s.status == SessionStatus::Exited).await;
    assert_eq!(
        (info.exit_code, info.seq, info.pid),
        (Some(3), out.len() as u64, None)
    );
}

/// Seconds from create to exit of `command`, nobody attached
async fn detached_secs(client: &mut Client, command: &str) -> f64 {
    let started = Instant::now();
    let info = created(client, command).await;
    loop {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Exit { session, .. } if session == info.id => break,
            _ => {}
        }
    }
    started.elapsed().as_secs_f64()
}

/// 32 MB of colored lines to `cat`: `yes` writes two bytes per syscall, too slow through a tty to flood
fn flood_file(dir: &Path) -> String {
    let mut out = Vec::with_capacity(33 * 1024 * 1024);
    for i in 0.. {
        if out.len() >= 32 * 1024 * 1024 {
            break;
        }
        let line = format!(
            "\x1b[3{}m{i:08} the quick brown fox jumps over the lazy dog\x1b[0m\n",
            i % 8
        );
        out.extend_from_slice(line.as_bytes());
    }
    let path = dir.join("flood.txt");
    std::fs::write(&path, out).unwrap();
    format!("sleep 0.3; cat '{}'", path.display())
}
const UNACKED_CEILING: u64 = 1024 * 1024 + 64 * 1024;

#[tokio::test]
async fn a_slow_client_lags_without_slowing_the_producer() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let flood = flood_file(dir.path());
    let detached = detached_secs(&mut client, &flood).await;

    let started = Instant::now();
    let info = created(&mut client, &flood).await;
    let (_, mut seq, _) = attach(&mut client, &info.id).await;
    let baseline = rss_bytes();
    let (mut peak_rss, mut resyncs) = (0u64, 0);
    let (mut attached, mut end) = (None, None);
    while end != Some(seq) {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Data {
                session,
                seq: at,
                bytes,
            } if session == info.id => {
                assert_eq!(at, seq, "Data continues from the attach or the last resync");
                seq += bytes.len() as u64;
                // A renderer at 4 MB/s, a tenth of xterm's, acking each frame once drawn
                tokio::time::sleep(Duration::from_micros(bytes.len() as u64 / 4)).await;
                client
                    .send(Request::Ack {
                        session: info.id.clone(),
                        bytes: bytes.len() as u64,
                    })
                    .await
                    .unwrap();
            }
            Event::Resync {
                session,
                channel,
                seq: at,
                ..
            } if session == info.id => {
                assert_eq!(channel, None);
                assert!(at >= seq, "resyncs only move forward");
                seq = at;
                resyncs += 1;
                peak_rss = peak_rss.max(rss_bytes());
            }
            Event::Exit { session, .. } if session == info.id => {
                attached = Some(started.elapsed().as_secs_f64());
                end = Some(info_seq(&mut client, &info.id).await);
            }
            _ => {}
        }
    }
    let attached = attached.unwrap();
    // Throttled to the renderer it would take 8 s
    assert!(
        attached < detached * 2.0 + 1.0,
        "attached {attached:.2} s, detached {detached:.2} s"
    );
    assert!(resyncs > 0);
    let growth = peak_rss.saturating_sub(baseline);
    assert!(
        growth < 96 * 1024 * 1024,
        "RSS grew by {} MB",
        growth / 1024 / 1024
    );
}

async fn info_seq(client: &mut Client, session: &str) -> u64 {
    list(client)
        .await
        .into_iter()
        .find(|s| s.id == session)
        .expect("session")
        .seq
}

#[tokio::test]
async fn channels_on_one_connection_lag_independently_and_resync_to_the_screen() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    // Twice HIGH_WATER: enough to make channel 2 lag, small enough to finish long before it counts as stuck
    // (5 s), which pauses the PTY for good since channel 2 never acks
    let info = created(&mut client, "sleep 0.3; yes | head -c 2000000").await;
    for channel in [1, 2] {
        let resp = client
            .request(Request::AttachChannel {
                session: info.id.clone(),
                channel,
            })
            .await
            .unwrap();
        assert!(matches!(resp, Response::Attached { seq: 0, .. }));
    }
    let (mut live, mut yes, mut stalled) = (0u64, 0usize, 0u64);
    loop {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::ChannelData {
                channel: 1,
                seq,
                bytes,
                ..
            } => {
                assert_eq!(seq, live);
                live += bytes.len() as u64;
                yes += bytes.iter().filter(|&&b| b == b'y').count();
                client
                    .send(Request::AckChannel {
                        session: info.id.clone(),
                        channel: 1,
                        bytes: bytes.len() as u64,
                    })
                    .await
                    .unwrap();
            }
            // Never acks, like a channel of a webview that went away
            Event::ChannelData {
                channel: 2, bytes, ..
            } => stalled += bytes.len() as u64,
            Event::Resync { .. } => panic!("nobody caught up"),
            Event::Exit { session, .. } if session == info.id => break,
            _ => {}
        }
    }
    assert_eq!(yes, 1_000_000, "the acking channel got every byte");
    assert!(
        stalled <= UNACKED_CEILING,
        "{stalled} sent to the stalled channel"
    );
    let end = info_seq(&mut client, &info.id).await;
    assert_eq!(live, end);
    client
        .send(Request::AckChannel {
            session: info.id.clone(),
            channel: 2,
            bytes: stalled,
        })
        .await
        .unwrap();
    let snapshot = loop {
        if let Event::Resync {
            channel,
            seq,
            snapshot,
            ..
        } = client.next_event().await.unwrap().expect("connection open")
        {
            assert_eq!((channel, seq), (Some(2), end));
            break snapshot;
        }
    };
    let (screen, _, _) = attach(&mut client, &info.id).await;
    assert_eq!(snapshot, screen, "the resync is the final screen");
}

#[tokio::test]
async fn attach_snapshot_then_live_data() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let info = created(
        &mut client,
        r"printf '\033[1;32mgreen\033[0m\r\n'; exec cat",
    )
    .await;
    let before = wait_for_info(&mut client, &info.id, |s| s.seq > 0).await;
    let (snapshot, seq, attached) = attach(&mut client, &info.id).await;
    assert_eq!(seq, before.seq);
    assert_eq!(attached.seq, seq);
    let text = String::from_utf8_lossy(&snapshot);
    assert!(text.contains("\x1b[0;1;32mgreen"), "{text:?}");

    client
        .request(Request::Write {
            session: info.id.clone(),
            data: b"typed\r".to_vec(),
        })
        .await
        .unwrap();
    let mut live = Vec::new();
    while !String::from_utf8_lossy(&live).contains("typed\r\ntyped") {
        if let Event::Data { seq: at, bytes, .. } = client.next_event().await.unwrap().unwrap() {
            assert_eq!(at, seq + live.len() as u64);
            live.extend_from_slice(&bytes);
        }
    }
    client
        .request(Request::Kill {
            session: info.id.clone(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn kill_reaps_grandchildren() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let info = created(&mut client, "sleep 0.3; sleep 100 & echo bg=$!; sleep 100").await;
    let (_, mut seq, _) = attach(&mut client, &info.id).await;
    let mut out = String::new();
    let grandchild: i32 = loop {
        if let Event::Data { bytes, seq: at, .. } = client.next_event().await.unwrap().unwrap() {
            assert_eq!(at, seq);
            seq += bytes.len() as u64;
            out.push_str(&String::from_utf8_lossy(&bytes));
            if let Some(pid) = out
                .split("bg=")
                .nth(1)
                .and_then(|r| r.split('\r').next())
                .filter(|_| out.contains('\n'))
            {
                break pid.trim().parse().unwrap();
            }
        }
    };
    let started = Instant::now();
    client
        .request(Request::Kill {
            session: info.id.clone(),
        })
        .await
        .unwrap();
    let (_, code) = output_until_exit(&mut client, &info.id, seq).await;
    assert!(code.is_some());
    assert!(started.elapsed() < Duration::from_secs(4));
    let gone = || nix::sys::signal::kill(nix::unistd::Pid::from_raw(grandchild), None).is_err();
    while !gone() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "grandchild {grandchild} survived"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn shutdown_restores_sessions_ui_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let info = created(
        &mut client,
        r"printf 'persist \033[35mme\033[0m'; sleep 100",
    )
    .await;
    let before = wait_for_info(&mut client, &info.id, |s| s.seq > 0).await;
    client
        .request(Request::PutUi {
            json: r#"{"tabs":[1]}"#.into(),
        })
        .await
        .unwrap();
    assert_eq!(
        client.request(Request::Shutdown).await.unwrap(),
        Response::Ok
    );
    server.join().unwrap().unwrap();
    assert!(
        dir.path()
            .join(format!("sessions/{}.ansi.zst", info.id))
            .exists()
    );

    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    assert_eq!(
        client.request(Request::GetUi).await.unwrap(),
        Response::Ui(Some(r#"{"tabs":[1]}"#.into()))
    );
    let restored = list(&mut client)
        .await
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session kept");
    assert_eq!(
        (restored.status, restored.pid, restored.seq),
        (SessionStatus::Restored, None, before.seq)
    );
    let (snapshot, seq, _) = attach(&mut client, &info.id).await;
    assert!(String::from_utf8_lossy(&snapshot).contains("persist \x1b[0;35mme"));
    let write = Request::Write {
        session: info.id.clone(),
        data: b"x".to_vec(),
    };
    assert!(
        client.request(write).await.is_err(),
        "no process to write to"
    );

    assert_eq!(
        client
            .request(Request::Restart {
                session: info.id.clone()
            })
            .await
            .unwrap(),
        Response::Ok
    );
    let mut live = Vec::new();
    while !String::from_utf8_lossy(&live).contains("persist") {
        if let Event::Data { seq: at, bytes, .. } = client.next_event().await.unwrap().unwrap() {
            assert_eq!(at, seq + live.len() as u64);
            live.extend_from_slice(&bytes);
        }
    }
    let running = wait_for_info(&mut client, &info.id, |s| {
        s.status == SessionStatus::Running
    })
    .await;
    assert!(running.pid.is_some_and(|pid| Some(pid) != info.pid));
    let (snapshot, ..) = attach(&mut client, &info.id).await;
    assert_eq!(
        String::from_utf8_lossy(&snapshot)
            .matches("persist")
            .count(),
        2,
        "old screen kept above"
    );
    client.request(Request::Shutdown).await.unwrap();
}

#[tokio::test]
async fn crash_marks_sessions_crashed() {
    let dir = tempfile::tempdir().unwrap();
    let state = serde_json::json!({
        "clean_shutdown": false,
        "ui": null,
        "sessions": [{ "info": {
            "id": "abc", "kind": "Shell", "cwd": "/", "title": "sh", "status": "Running", "pid": 1,
            "exit_code": null, "cols": 80, "rows": 24, "created_at": 1, "command": [], "seq": 5,
            "agent_session": null, "routine": null
        }, "env": [] }]
    });
    std::fs::write(dir.path().join("state.json"), state.to_string()).unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let crashed = list(&mut client).await.remove(0);
    assert_eq!(
        (crashed.status, crashed.pid),
        (SessionStatus::Crashed, None)
    );
    client.request(Request::Shutdown).await.unwrap();
}

#[tokio::test]
async fn second_daemon_exits_when_one_answers() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let opts = treeix_ptyd::Opts {
        data_dir: dir.path().into(),
        socket: dir.path().join("ptyd.sock"),
        handle_signals: false,
    };
    std::thread::spawn(move || treeix_ptyd::run(opts))
        .join()
        .unwrap()
        .unwrap();
    let mut client = connect(dir.path()).await;
    assert!(list(&mut client).await.is_empty());
    client.request(Request::Shutdown).await.unwrap();
}

#[tokio::test]
async fn clear_drops_scrollback_and_keeps_the_cursor_line_on_top() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = connect(dir.path()).await;
    let info = created(
        &mut client,
        r"i=0; while [ $i -lt 40 ]; do echo old$i; i=$((i+1)); done; printf 'prompt$ '; exec cat",
    )
    .await;
    wait_for_info(&mut client, &info.id, |s| s.seq > 200).await;
    assert_eq!(
        client
            .request(Request::Clear {
                session: info.id.clone()
            })
            .await
            .unwrap(),
        Response::Ok
    );
    let (snapshot, ..) = attach(&mut client, &info.id).await;
    let text = String::from_utf8_lossy(&snapshot);
    assert!(!text.contains("old"), "{text:?}");
    assert!(text.starts_with("\x1bcprompt$\r\n"), "{text:?}");
    assert!(
        text.contains("\x1b[1;9H"),
        "cursor after the prompt: {text:?}"
    );
    client.request(Request::Shutdown).await.unwrap();
}
