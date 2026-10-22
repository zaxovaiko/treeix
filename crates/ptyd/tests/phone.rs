//! The phone page's API end to end, over remote.sock the way `tailscale serve` reaches it

use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use treeix_proto::{CreateSession, Request, Response, SessionKind};
use treeix_ptyd::client::Client;

const OWNER: &str = "me@example.com";

/// Status and body of one HTTP/1.1 request as the tailnet owner
async fn http(dir: &Path, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut stream = UnixStream::connect(dir.join("remote.sock")).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: mac.tail1.ts.net\r\nTailscale-User-Login: {OWNER}\r\n\
         Sec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let status = response[9..12].parse().unwrap();
    let body = response.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, body.to_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_lists_sessions_types_into_them_and_reads_the_screen() {
    let dir = tempfile::tempdir().unwrap();
    let _server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut client = Client::connect(&dir.path().join("ptyd.sock"))
        .await
        .unwrap();
    let create = Request::Create(CreateSession {
        kind: SessionKind::Shell,
        cwd: None,
        command: vec!["sh".into()],
        env: vec![],
        cols: 80,
        rows: 24,
        title: None,
        routine: None,
    });
    let Response::Created(session) = client.request(create).await.unwrap() else {
        panic!("not created");
    };

    let (status, body) = http(dir.path(), "GET", "/api/state", "").await;
    assert_eq!(status, 403, "off until settings name an owner: {body}");

    let settings = format!(r#"{{"phone":{{"owner":"{OWNER}"}}}}"#);
    std::fs::write(dir.path().join("settings.json"), settings).unwrap();
    let (status, body) = http(dir.path(), "GET", "/api/state", "").await;
    assert_eq!(status, 200);
    assert!(body.contains(&session.id), "{body}");

    let input = format!("/api/sessions/{}/input", session.id);
    let (status, _) = http(
        dir.path(),
        "POST",
        &input,
        r#"{"text":"echo phone-$((40+2))\r"}"#,
    )
    .await;
    assert_eq!(status, 204);

    let screen = format!("/api/sessions/{}/screen", session.id);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (status, body) = http(dir.path(), "GET", &screen, "").await;
        assert_eq!(status, 200);
        if body.contains("phone-42") {
            break;
        }
        assert!(Instant::now() < deadline, "never echoed: {body}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The shell is idle at its prompt now
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_, body) = http(dir.path(), "GET", &screen, "").await;
    let seq = serde_json::from_str::<serde_json::Value>(&body).unwrap()["seq"].clone();
    let (_, same) = http(dir.path(), "GET", &format!("{screen}?seq={seq}"), "").await;
    assert!(
        !same.contains("\"lines\""),
        "no lines when nothing changed: {same}"
    );
}
