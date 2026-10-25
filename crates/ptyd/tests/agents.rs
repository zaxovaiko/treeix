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

#[tokio::test]
async fn a_shell_running_claude_turns_into_a_claude_session_until_it_exits() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let info = created(
        &mut client,
        SessionKind::Shell,
        r#"exec bash -c 'exec -a claude bash -c "sleep 3; exec -a zsh sleep 10"'"#,
    )
    .await;
    let mut kinds = Vec::new();
    while kinds.len() < 2 {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Kind { session, kind } if session == info.id => kinds.push(kind),
            _ => {}
        }
    }
    assert_eq!(kinds, [SessionKind::Claude, SessionKind::Shell]);
}

#[tokio::test]
async fn an_interactive_shell_is_idle_at_its_prompt_and_running_a_command() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let Response::Created(info) = client
        .request(Request::Create(CreateSession {
            command: vec![],
            ..match create(SessionKind::Shell, "") {
                Request::Create(create) => create,
                _ => unreachable!(),
            }
        }))
        .await
        .unwrap()
    else {
        panic!("not created");
    };
    wait_for_status(&mut client, &info.id, SessionStatus::Idle).await;
    client
        .request(Request::Write {
            session: info.id.clone(),
            data: b"sleep 4\r".to_vec(),
        })
        .await
        .unwrap();
    wait_for_status(&mut client, &info.id, SessionStatus::Running).await;
    wait_for_status(&mut client, &info.id, SessionStatus::Idle).await;
}

#[tokio::test]
async fn restarting_a_restored_shell_resumes_the_claude_it_ran() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let resumed = dir.path().join("resumed");
    let claude = bin.join("claude");
    std::fs::write(
        &claude,
        format!("#!/bin/sh\necho \"$@\" > '{}'\n", resumed.display()),
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    // Skips zsh's new-user wizard, which would eat the typed line
    std::fs::write(dir.path().join(".zshrc"), "").unwrap();
    let server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let Response::Created(info) = client
        .request(Request::Create(CreateSession {
            command: vec![],
            // The user's rc files and their real claude stay out
            env: vec![
                ("HOME".into(), dir.path().display().to_string()),
                ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
            ],
            ..match create(SessionKind::Shell, "") {
                Request::Create(create) => create,
                _ => unreachable!(),
            }
        }))
        .await
        .unwrap()
    else {
        panic!("not created");
    };
    client
        .request(Request::Write {
            session: info.id.clone(),
            data: b"bash -c 'exec -a claude sleep 100'\r".to_vec(),
        })
        .await
        .unwrap();
    loop {
        match client.next_event().await.unwrap().expect("connection open") {
            Event::Kind {
                session,
                kind: SessionKind::Claude,
            } if session == info.id => break,
            _ => {}
        }
    }
    client
        .request(Request::SetAgentSession {
            session: info.id.clone(),
            agent_session: "abc-123".into(),
        })
        .await
        .unwrap();
    client.request(Request::Shutdown).await.unwrap();
    server.join().unwrap().unwrap();

    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .expect("connect");
    let Response::Sessions(list) = client.request(Request::List).await.unwrap() else {
        panic!("no session list");
    };
    let restored = list.iter().find(|s| s.id == info.id).expect("session kept");
    assert_eq!(
        (restored.kind, restored.status),
        (SessionKind::Claude, SessionStatus::Restored)
    );
    client
        .request(Request::Restart {
            session: info.id.clone(),
        })
        .await
        .unwrap();
    let start = Instant::now();
    while std::fs::read_to_string(&resumed).map_or(true, |args| args.trim() != "--resume abc-123") {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "claude was not resumed"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
