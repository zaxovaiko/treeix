use crate::daemon::Daemon;
use crate::types::{Attached, CreateSession, Frame, Hello, SessionInfo};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use treeix_core::places::{self, Place};
use treeix_proto::{Request, Response};

type Result<T> = std::result::Result<T, String>;

fn unexpected(resp: Response) -> String {
    format!("unexpected daemon reply: {resp:?}")
}

async fn ok(daemon: &Daemon, req: Request) -> Result<()> {
    match daemon.request(req).await? {
        Response::Ok => Ok(()),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn hello(daemon: State<'_, Arc<Daemon>>) -> Result<Hello> {
    daemon.hello().await
}

#[tauri::command]
#[specta::specta]
pub async fn sessions(daemon: State<'_, Arc<Daemon>>) -> Result<Vec<SessionInfo>> {
    match daemon.request(Request::List).await? {
        Response::Sessions(list) => Ok(list.into_iter().map(Into::into).collect()),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create(daemon: State<'_, Arc<Daemon>>, opts: CreateSession) -> Result<SessionInfo> {
    match daemon.request(Request::Create(opts.into())).await? {
        Response::Created(info) => Ok(info.into()),
        other => Err(unexpected(other)),
    }
}

/// The snapshot arrives as the channel's first message, then every output chunk as one message each
#[tauri::command]
#[specta::specta]
pub async fn attach(
    daemon: State<'_, Arc<Daemon>>,
    id: String,
    channel: Channel<Frame>,
) -> Result<Attached> {
    match daemon.attach(id, channel).await? {
        Response::Attached { seq, info, .. } => Ok(Attached {
            seq,
            info: info.into(),
        }),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn detach(daemon: State<'_, Arc<Daemon>>, id: String, channel: u32) -> Result<()> {
    match daemon.detach(id, channel).await? {
        Response::Ok => Ok(()),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn write(daemon: State<'_, Arc<Daemon>>, id: String, data: String) -> Result<()> {
    ok(
        &daemon,
        Request::Write {
            session: id,
            data: data.into_bytes(),
        },
    )
    .await
}

/// Input that is not UTF-8 (rare: some paste and mouse encodings)
#[tauri::command]
#[specta::specta]
pub async fn write_bytes(daemon: State<'_, Arc<Daemon>>, id: String, data: Vec<u8>) -> Result<()> {
    ok(&daemon, Request::Write { session: id, data }).await
}

#[tauri::command]
#[specta::specta]
pub async fn resize(
    daemon: State<'_, Arc<Daemon>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    ok(
        &daemon,
        Request::Resize {
            session: id,
            cols,
            rows,
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn ack(daemon: State<'_, Arc<Daemon>>, id: String, bytes: u64) -> Result<()> {
    ok(&daemon, Request::Ack { session: id, bytes }).await
}

#[tauri::command]
#[specta::specta]
pub async fn kill(daemon: State<'_, Arc<Daemon>>, id: String) -> Result<()> {
    ok(&daemon, Request::Kill { session: id }).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove(daemon: State<'_, Arc<Daemon>>, id: String) -> Result<()> {
    ok(&daemon, Request::Remove { session: id }).await
}

#[tauri::command]
#[specta::specta]
pub async fn restart(daemon: State<'_, Arc<Daemon>>, id: String) -> Result<()> {
    match daemon.request(Request::Restart { session: id }).await? {
        Response::Ok | Response::Created(_) => Ok(()),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_ui(daemon: State<'_, Arc<Daemon>>) -> Result<Option<String>> {
    match daemon.request(Request::GetUi).await? {
        Response::Ui(json) => Ok(json),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn put_ui(daemon: State<'_, Arc<Daemon>>, json: String) -> Result<()> {
    ok(&daemon, Request::PutUi { json }).await
}

#[tauri::command]
#[specta::specta]
pub async fn places(app: AppHandle, paths: Vec<String>) -> Result<Vec<Place>> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || places::resolve_all(&paths, &home))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn home_dir(app: AppHandle) -> Result<String> {
    app.path()
        .home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Global chord that toggles the quick terminal; None turns it off
#[tauri::command]
#[specta::specta]
pub fn set_quick_shortcut(app: AppHandle, accelerator: Option<String>) -> Result<()> {
    crate::quick::set_shortcut(&app, accelerator.as_deref()).map_err(|e| e.to_string())
}

/// The `TREEIX_AUTORUN` runner this app was started with (src/autorun.ts)
#[tauri::command]
#[specta::specta]
pub fn autorun() -> Option<String> {
    crate::autorun()
}

/// Saves the autorun's report as data_dir/<name>-<millis>.json, then quits with its exit code
#[tauri::command]
#[specta::specta]
pub fn autorun_done(app: AppHandle, report: String, code: i32) -> Result<String> {
    let name = crate::autorun().ok_or("not started with TREEIX_AUTORUN")?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dir = treeix_proto::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}-{millis}.json"));
    std::fs::write(&path, report).map_err(|e| e.to_string())?;
    app.exit(code);
    Ok(path.to_string_lossy().into_owned())
}
