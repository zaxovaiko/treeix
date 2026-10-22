//! Settings (treeix_core::settings) and keyring secrets, which never come back to the webview. Owner: U6

use super::Result;
use super::files::blocking;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;
use treeix_core::secrets::{self, Secret};
use treeix_core::settings::{self, Settings};

/// Saved settings, from any window
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct SettingsChanged {
    pub settings: Settings,
}

#[tauri::command]
#[specta::specta]
pub async fn get_settings() -> Result<Settings> {
    blocking(|| Ok(settings::load(&treeix_proto::data_dir()))).await
}

/// Deep-merges `patch` (any subset of Settings) and saves; rejects an invalid one without saving
#[tauri::command]
#[specta::specta]
pub async fn update_settings(app: AppHandle, patch: Value) -> Result<Settings> {
    let saved = blocking(move || settings::update(&treeix_proto::data_dir(), &patch)).await?;
    let event = SettingsChanged {
        settings: saved.clone(),
    };
    if let Err(e) = event.emit(&app) {
        tracing::warn!("settings event not sent: {e}");
    }
    Ok(saved)
}

/// Whether the secret is saved; its value never leaves Rust
#[tauri::command]
#[specta::specta]
pub async fn has_secret(secret: Secret) -> Result<bool> {
    blocking(move || Ok(secrets::get(&treeix_proto::data_dir(), secret)?.is_some())).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_secret(secret: Secret, value: String) -> Result<()> {
    blocking(move || secrets::set(&treeix_proto::data_dir(), secret, value.trim())).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_secret(secret: Secret) -> Result<()> {
    blocking(move || secrets::delete(&treeix_proto::data_dir(), secret)).await
}
