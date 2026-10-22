//! Local file history and closed sessions over treeix_core::history.

use super::Result;
use super::files::{blocking, history_dir, now_ms};
use crate::types::{SessionInfo, SessionKind};
use std::path::{Path, PathBuf};
use treeix_core::history::{self, HistoryEntry, RecordKind, SessionRecord};
use treeix_core::places;

/// Next to the UI state in app data
fn sessions_file() -> PathBuf {
    treeix_proto::data_dir().join("sessions.jsonl")
}

/// Snapshots of a file, newest first
#[tauri::command]
#[specta::specta]
pub async fn list_history(root: String, file: String) -> Result<Vec<HistoryEntry>> {
    blocking(move || Ok(history::list(&history_dir(), &root, &file))).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_history(root: String, file: String, id: String) -> Result<String> {
    blocking(move || history::read(&history_dir(), &root, &file, &id)).await
}

/// Closed sessions, newest first
#[tauri::command]
#[specta::specta]
pub async fn session_history() -> Result<Vec<SessionRecord>> {
    blocking(|| Ok(history::sessions(&sessions_file()))).await
}

/// Drops a record from History
#[tauri::command]
#[specta::specta]
pub async fn forget_session(id: String) -> Result<()> {
    blocking(move || history::forget_session(&sessions_file(), &id)).await
}

/// Keeps a removed session for the History panel, with the branch and repo it ran in; routines are not kept
pub(super) async fn record_closed(info: SessionInfo, home: PathBuf) {
    let kind = match info.kind {
        SessionKind::Shell => RecordKind::Shell,
        SessionKind::Claude => RecordKind::Claude,
        SessionKind::Codex => RecordKind::Codex,
        SessionKind::Routine => return,
    };
    let recorded = blocking(move || {
        let place = places::resolve(Path::new(&info.cwd), &home);
        let (messages, cost, first_prompt) = super::agents::record_stats(&home, &info);
        let record = SessionRecord {
            id: info.id,
            kind,
            title: info.title,
            cwd: info.cwd,
            branch: place.branch,
            repo_root: place.repo_root,
            agent_session: info.agent_session,
            command: info.command,
            created_at: info.created_at,
            closed_at: now_ms(),
            messages,
            cost,
            first_prompt,
            run: None,
        };
        history::record_session(&sessions_file(), &record)
    })
    .await;
    if let Err(e) = recorded {
        tracing::warn!("closed session not recorded: {e}");
    }
}
