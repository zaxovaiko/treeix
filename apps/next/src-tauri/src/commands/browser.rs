//! Browser pane commands over crate::browser. Webview work that waits (creating one, checking a dev server) runs
//! off the main thread, which it waits on. Contract: docs/next/phase67-contract.md. Owner: B7

use super::Result;
use super::files::blocking;
use crate::browser::{self, Bounds, BrowserNav, BrowserProfile, BrowserState, CookieImport};
use tauri::AppHandle;

/// Creates the pane's webview (hidden) or returns the one it has
#[tauri::command]
#[specta::specta]
pub async fn browser_open(app: AppHandle, pane: String, url: String) -> Result<BrowserState> {
    blocking(move || browser::open(&app, &pane, &url)).await
}

/// Lays the webview over the pane's rect; null hides it under popovers and dialogs
#[tauri::command]
#[specta::specta]
pub fn browser_place(app: AppHandle, pane: String, bounds: Option<Bounds>) -> Result<()> {
    browser::place(&app, &pane, bounds)
}

#[tauri::command]
#[specta::specta]
pub fn browser_close(app: AppHandle, pane: String) -> Result<()> {
    browser::close(&app, &pane)
}

/// A URL, a host like `localhost:5173`, or search text
#[tauri::command]
#[specta::specta]
pub async fn browser_navigate(app: AppHandle, pane: String, input: String) -> Result<()> {
    blocking(move || browser::navigate(&app, &pane, &input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn browser_go(app: AppHandle, pane: String, nav: BrowserNav) -> Result<()> {
    blocking(move || browser::go(&app, &pane, nav)).await
}

#[tauri::command]
#[specta::specta]
pub fn browser_devtools(app: AppHandle, pane: String) -> Result<()> {
    browser::devtools(&app, &pane)
}

#[tauri::command]
#[specta::specta]
pub async fn browser_cookie_profiles() -> Result<Vec<BrowserProfile>> {
    blocking(browser::cookie_profiles).await
}

#[tauri::command]
#[specta::specta]
pub async fn browser_import_cookies(app: AppHandle, profile: String) -> Result<CookieImport> {
    blocking(move || browser::import_cookies(&app, &profile)).await
}

#[tauri::command]
#[specta::specta]
pub async fn browser_clear_data(app: AppHandle) -> Result<()> {
    blocking(move || browser::clear_data(&app)).await
}

/// The command that starts the folder's dev server on a free port, for the start page; null without one
#[tauri::command]
#[specta::specta]
pub async fn browser_dev_command(folder: String) -> Result<Option<String>> {
    blocking(move || browser::dev_command(&folder)).await
}
