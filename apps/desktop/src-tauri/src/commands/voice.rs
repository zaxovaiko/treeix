//! Dictation and recording commands over crate::voice. Owner: V7

use super::Result;
use super::files::blocking;
use crate::voice::{
    self, AccessKind, DictationEntry, DictationStatus, RecordingInfo, RecordingNote,
    RecordingStatus,
};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub fn dictation_status(app: AppHandle) -> Result<DictationStatus> {
    voice::dictation_status(&app)
}

/// Starts or ends listening, like a tap on the hotkey
#[tauri::command]
#[specta::specta]
pub fn dictation_toggle(app: AppHandle) -> Result<()> {
    voice::dictation_toggle(&app)
}

/// Progress arrives as `VoiceEvent::Dictation`
#[tauri::command]
#[specta::specta]
pub fn voice_model_download(app: AppHandle, model: String) -> Result<()> {
    voice::model_download(&app, &model)
}

#[tauri::command]
#[specta::specta]
pub fn voice_model_delete(app: AppHandle, model: String) -> Result<()> {
    voice::model_delete(&app, &model)
}

#[tauri::command]
#[specta::specta]
pub fn voice_request_access(app: AppHandle, kind: AccessKind) -> Result<()> {
    voice::request_access(&app, kind)
}

#[tauri::command]
#[specta::specta]
pub async fn dictation_history() -> Result<Vec<DictationEntry>> {
    blocking(voice::dictation_history).await
}

/// Drops one dictation by its `at`, or the whole history when null
#[tauri::command]
#[specta::specta]
pub async fn dictation_forget(at: Option<u64>) -> Result<()> {
    blocking(move || voice::dictation_forget(at)).await
}

#[tauri::command]
#[specta::specta]
pub fn recording_status(app: AppHandle) -> Result<RecordingStatus> {
    voice::recording_status(&app)
}

/// null takes the title from the app in the call, else `Recording`
#[tauri::command]
#[specta::specta]
pub fn recording_start(app: AppHandle, title: Option<String>) -> Result<RecordingStatus> {
    voice::recording_start(&app, title)
}

#[tauri::command]
#[specta::specta]
pub fn recording_pause(app: AppHandle, paused: bool) -> Result<RecordingStatus> {
    voice::recording_pause(&app, paused)
}

#[tauri::command]
#[specta::specta]
pub fn recording_stop(app: AppHandle) -> Result<RecordingStatus> {
    voice::recording_stop(&app)
}

#[tauri::command]
#[specta::specta]
pub async fn recordings() -> Result<Vec<RecordingInfo>> {
    blocking(voice::recordings).await
}

#[tauri::command]
#[specta::specta]
pub async fn recording_read(id: String) -> Result<RecordingNote> {
    blocking(move || voice::recording_read(&id)).await
}

/// Moves the recording's folder to the Trash
#[tauri::command]
#[specta::specta]
pub async fn recording_delete(id: String) -> Result<()> {
    blocking(move || voice::recording_delete(&id)).await
}
