//! App updates through tauri-plugin-updater: `latest.json` on the GitHub release, minisign-signed (docs/next/updater.md).
//! Checked on start when `settings.updates.autoCheck` is on, from the tray menu and from Settings > About

use crate::commands::UpdateInfo;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const INSTALL: &str = "Restart and install";

/// The update the last check found, for `install`
#[derive(Default)]
pub struct Found(Mutex<Option<Update>>);

/// None when this is the newest version
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    *app.state::<Found>().0.lock().await = update;
    Ok(info)
}

/// Downloads, installs and restarts; ptyd keeps the sessions, the new build's handshake replaces it
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let found = app.state::<Found>().0.lock().await.clone();
    let update = match found {
        Some(update) => update,
        None => match check(app).await? {
            Some(_) => app
                .state::<Found>()
                .0
                .lock()
                .await
                .clone()
                .ok_or("no update")?,
            None => return Err("Treeix is up to date".into()),
        },
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

/// Checks and, when there is an update, asks to restart into it. `quiet` (on start) says nothing when there is none
pub async fn check_and_ask(app: AppHandle, quiet: bool) {
    let message = match check(&app).await {
        Ok(Some(info)) => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .message(format!("Treeix {} is ready.", info.version))
                .title("Update")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    INSTALL.into(),
                    "Later".into(),
                ))
                .show_with_result(move |answer| {
                    let _ = tx.send(answer);
                });
            // A custom label comes back as Ok on some platforms, as the label on others
            let install_now = match rx.await {
                Ok(MessageDialogResult::Ok) => true,
                Ok(MessageDialogResult::Custom(label)) => label == INSTALL,
                _ => false,
            };
            if !install_now {
                return;
            }
            match install(&app).await {
                Ok(()) => return,
                Err(e) => format!("The update failed: {e}"),
            }
        }
        Ok(None) => "Treeix is up to date.".into(),
        Err(e) => format!("Couldn't check for updates: {e}"),
    };
    if quiet {
        tracing::info!("update check: {message}");
        return;
    }
    app.dialog().message(message).title("Update").show(|_| {});
}
