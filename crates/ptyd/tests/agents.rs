use std::time::{Duration, Instant};
use treeix_proto::{
    CreateSession, Event, ProgressState, Request, Response, SessionInfo, SessionKind, SessionStatus,
};
use treeix_ptyd::client::Client;

fn create(kind: SessionKind, command: &str) -> Request {
    Request::Create(CreateSession {
        kind,
        cwd: None,
        command: vec!["sh".into(), "-c".into(), command.into()],
        env: vec![],
        cols: 80,
        rows: 24,
        title: None,
        routine: None,
    })
}

async fn created(client: &mut Client, kind: SessionKind, command: &str) -> SessionInfo {
    match client.request(create(kind, command)).await.unwrap() {
        Response::Created(info) => info,
        other => panic!("{other:?}"),
    }
}

async fn wait_for_status(client: &mut Client, session: &str, status: SessionStatus) {
    let start = Instant::now();
    loop {
        let Response::Sessions(list) = client.request(Request::List).await.unwrap() else {
            panic!("no session list");
        };
        if list.iter().any(|s| s.id == session && s.status == status) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_claude_hook_writing_its_status_file_flips_the_session_status() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let hook = r#"printf %s "$1" > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION""#;
    let script = format!(
        "hook() {{ {hook}; }}; sleep 0.5; hook working; sleep 1.5; hook input; sleep 1.5; hook done; exec cat"
    );
    let info = created(&mut client, SessionKind::Claude, &script).await;
    wait_for_status(&mut client, &info.id, SessionStatus::Running).await;
    wait_for_status(&mut client, &info.id, SessionStatus::Needs).await;
    wait_for_status(&mut client, &info.id, SessionStatus::Done).await;
}

#[tokio::test]
async fn osc_9_4_progress_reaches_clients_and_clears_on_exit() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let info = created(
        &mut client,
        SessionKind::Shell,
        r"sleep 0.3; printf '\033]9;4;1;42\007'; sleep 0.3",
    )
    .await;
    let mut seen = Vec::new();
    while seen.len() < 2 {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Progress {
                session,
                state,
                percent,
            } if session == info.id => seen.push((state, percent)),
            _ => {}
        }
    }
    assert_eq!(seen, [(ProgressState::Normal, 42), (ProgressState::Off, 0)]);
}
