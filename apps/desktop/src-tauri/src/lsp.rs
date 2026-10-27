//! Language servers for the editor. Each runs in its place's folder from the user's login shell, so PATH matches the
//! terminals and the repo's node_modules/.bin comes first, and speaks JSON-RPC over stdio; the page is the LSP client

use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// What the page writes to each running server, by id
#[derive(Default)]
pub struct Servers {
    next: AtomicU32,
    inputs: Mutex<HashMap<u32, mpsc::UnboundedSender<String>>>,
}

#[derive(Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspOutput {
    /// One JSON-RPC message from the server
    Message { body: String },
    /// The server is gone: 127 when its command isn't installed, and the end of its stderr says why
    Exit { code: Option<i32>, stderr: String },
}

/// Of a server's stderr, only the end is kept for the exit message; some log a lot
const STDERR_TAIL: usize = 4000;

/// Starts `command` in `root`; its messages, then its exit, come on `output`
#[tauri::command]
#[specta::specta]
pub async fn lsp_start(
    app: AppHandle,
    servers: State<'_, Servers>,
    root: String,
    command: Vec<String>,
    output: Channel<LspOutput>,
) -> Result<u32, String> {
    if command.is_empty() {
        return Err("no command".into());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = tokio::process::Command::new(shell)
        .arg("-lc")
        .arg(r#"PATH="$PWD/node_modules/.bin:$PATH" exec "$0" "$@""#)
        .args(&command)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{}: {e}", command[0]))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("no pipes".into());
    };
    let id = servers.next.fetch_add(1, Ordering::Relaxed);
    let (input, mut inputs) = mpsc::unbounded_channel::<String>();
    lock(&servers).insert(id, input);

    let messages = output.clone();
    let mut reader = tauri::async_runtime::spawn(async move {
        read_messages(BufReader::new(stdout), |body| {
            messages.send(LspOutput::Message { body }).is_ok()
        })
        .await
    });
    let tail = tauri::async_runtime::spawn(stderr_tail(stderr));
    tauri::async_runtime::spawn(async move {
        // Stopped, or the page that started it is gone: no one reads it any more
        let unread = loop {
            tokio::select! {
                body = inputs.recv() => match body {
                    Some(body) => {
                        // A dead server's write fails; its exit is reported below
                        let _ = stdin.write_all(frame(&body).as_bytes()).await;
                    }
                    None => break true,
                },
                page_gone = &mut reader => break page_gone.unwrap_or(true),
            }
        };
        if unread {
            let _ = child.kill().await;
        }
        drop(stdin);
        let code = child.wait().await.ok().and_then(|status| status.code());
        lock(&app.state::<Servers>()).remove(&id);
        let stderr = tail.await.unwrap_or_default();
        let _ = output.send(LspOutput::Exit { code, stderr });
    });
    Ok(id)
}

/// Writes one JSON-RPC message to a running server
#[tauri::command]
#[specta::specta]
pub fn lsp_send(servers: State<'_, Servers>, id: u32, body: String) -> Result<(), String> {
    lock(&servers)
        .get(&id)
        .and_then(|input| input.send(body).ok())
        .ok_or_else(|| "language server stopped".into())
}

/// Kills a server; the client sends `shutdown` and `exit` first for a clean stop
#[tauri::command]
#[specta::specta]
pub fn lsp_stop(servers: State<'_, Servers>, id: u32) {
    lock(&servers).remove(&id);
}

fn lock(
    servers: &Servers,
) -> std::sync::MutexGuard<'_, HashMap<u32, mpsc::UnboundedSender<String>>> {
    servers.inputs.lock().unwrap_or_else(|e| e.into_inner())
}

fn frame(body: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{body}", body.len())
}

/// Hands each `Content-Length` framed body to `send` until the stream ends (false) or `send` refuses one (true)
async fn read_messages(
    mut stream: impl AsyncBufRead + Unpin,
    mut send: impl FnMut(String) -> bool,
) -> bool {
    let mut line = String::new();
    loop {
        let mut length = None;
        loop {
            line.clear();
            if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                return false;
            }
            let header = line.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(length) = length else { continue };
        let mut body = vec![0; length];
        if stream.read_exact(&mut body).await.is_err() {
            return false;
        }
        if !send(String::from_utf8_lossy(&body).into_owned()) {
            return true;
        }
    }
}

async fn stderr_tail(mut stream: impl AsyncRead + Unpin) -> String {
    let mut kept = Vec::new();
    let mut chunk = [0; 4096];
    while let Ok(n @ 1..) = stream.read(&mut chunk).await {
        kept.extend_from_slice(&chunk[..n]);
        kept.drain(..kept.len().saturating_sub(STDERR_TAIL));
    }
    String::from_utf8_lossy(&kept).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_framed_messages() {
        let stream = format!(
            "{}Content-Type: x\r\n{}",
            frame("{\"a\":1}"),
            frame("{\"é\":2}")
        );
        let mut got = Vec::new();
        let page_gone = read_messages(stream.as_bytes(), |body| {
            got.push(body);
            true
        })
        .await;
        assert!(!page_gone);
        assert_eq!(got, ["{\"a\":1}", "{\"é\":2}"]);
    }

    #[tokio::test]
    async fn stops_when_the_page_is_gone() {
        let stream = frame("{}").repeat(3);
        let mut count = 0;
        let page_gone = read_messages(stream.as_bytes(), |_| {
            count += 1;
            count < 2
        })
        .await;
        assert!(page_gone);
        assert_eq!(count, 2);
    }
}
