//! File commands over treeix_core::fs and treeix_core::search.

use super::Result;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri_specta::Event;
use treeix_core::fs::{self, PlaceFiles, Watch};
use treeix_core::search::{self, SearchOptions, SearchResult};

/// A debounced change under a root registered with `watch`
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    /// The id passed to `watch`
    pub id: String,
    /// Relative paths that changed, `.git` excluded
    pub paths: Vec<String>,
    /// Something under `.git` changed: git status is stale
    pub git: bool,
}

/// Runs blocking file work off the async runtime
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Snapshots before saves live in app data, keyed by place and file
pub(super) fn history_dir() -> PathBuf {
    treeix_proto::data_dir().join("history")
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// None when the root no longer exists
#[tauri::command]
#[specta::specta]
pub async fn list_files(root: String) -> Result<Option<PlaceFiles>> {
    blocking(move || Ok(fs::list_files(Path::new(&root)))).await
}

/// Names in one folder, folders ending with `/`, ignored ones included
#[tauri::command]
#[specta::specta]
pub async fn list_directory(root: String, folder: String) -> Result<Vec<String>> {
    blocking(move || fs::list_directory(Path::new(&root), &folder)).await
}

/// None for binary files and files over 2 MB
#[tauri::command]
#[specta::specta]
pub async fn read_file(root: String, file: String) -> Result<Option<String>> {
    blocking(move || fs::read_file(Path::new(&root), &file)).await
}

/// Snapshots the previous version into local history first. Fails with `SAVE_CONFLICT` when the file no longer matches `expected`; None overwrites
#[tauri::command]
#[specta::specta]
pub async fn save_file(
    root: String,
    file: String,
    contents: String,
    expected: Option<String>,
) -> Result<()> {
    blocking(move || {
        fs::save_file(
            Path::new(&root),
            &file,
            &contents,
            expected.as_deref(),
            || {
                // History is a nicety: a failed snapshot must not lose the save
                if let Err(e) = treeix_core::history::snapshot_before_save(
                    &history_dir(),
                    &root,
                    &file,
                    now_ms(),
                ) {
                    tracing::warn!("history snapshot of {file} failed: {e}");
                }
            },
        )
    })
    .await
}

/// A path ending in `/` creates a folder; parents are created too
#[tauri::command]
#[specta::specta]
pub async fn create_path(root: String, file: String) -> Result<()> {
    blocking(move || fs::create_path(Path::new(&root), &file)).await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_path(root: String, from: String, to: String) -> Result<()> {
    blocking(move || fs::rename_path(Path::new(&root), &from, &to)).await
}

/// Moves to the system Trash
#[tauri::command]
#[specta::specta]
pub async fn trash_path(root: String, file: String) -> Result<()> {
    blocking(move || fs::trash_path(Path::new(&root), &file)).await
}

/// `open` on macOS, `xdg-open` elsewhere; stderr is the error
fn launch(args: &[&str]) -> Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

/// Absolute paths only, so a path can never pass as a flag
fn absolute(path: &str) -> Result<&str> {
    if Path::new(path).is_absolute() {
        Ok(path)
    } else {
        Err(format!("{path} is not an absolute path"))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn reveal_in_finder(path: String) -> Result<()> {
    blocking(move || {
        let path = absolute(&path)?;
        if cfg!(target_os = "macos") {
            return launch(&["-R", path]);
        }
        let parent = Path::new(path)
            .parent()
            .map_or(path.into(), Path::to_string_lossy);
        launch(&[&parent])
    })
    .await
}

/// Opens with the default app
#[tauri::command]
#[specta::specta]
pub async fn open_path(path: String) -> Result<()> {
    blocking(move || launch(&[absolute(&path)?])).await
}

/// Opens an http(s) URL in the browser; other schemes are refused
#[tauri::command]
#[specta::specta]
pub async fn open_url(url: String) -> Result<()> {
    let scheme = url
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https")) {
        return Err(format!("Only http and https links open: {url}"));
    }
    blocking(move || launch(&[&url])).await
}

/// Fails with the regex error when `options.regex` and the pattern does not compile
#[tauri::command]
#[specta::specta]
pub async fn search_text(
    roots: Vec<String>,
    query: String,
    options: SearchOptions,
) -> Result<SearchResult> {
    blocking(move || search::search_text(&roots, &query, options)).await
}

fn watches() -> &'static Mutex<HashMap<String, Watch>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

/// Emits `FsEvent { id }` on changes under `root`, or to `file` alone when set. Same id again replaces the watch
#[tauri::command]
#[specta::specta]
pub async fn watch(app: AppHandle, id: String, root: String, file: Option<String>) -> Result<()> {
    blocking(move || {
        let event_id = id.clone();
        let watch = fs::watch(Path::new(&root), file.as_deref(), move |change| {
            let event = FsEvent {
                id: event_id.clone(),
                paths: change.paths,
                git: change.git,
            };
            if let Err(e) = event.emit(&app) {
                tracing::warn!("fs event not sent: {e}");
            }
        })?;
        watches()
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, watch);
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn unwatch(id: String) -> Result<()> {
    let removed = watches().lock().map_err(|e| e.to_string())?.remove(&id);
    // Stopping joins the debouncer thread: keep it off the async runtime
    blocking(move || {
        drop(removed);
        Ok(())
    })
    .await
}
