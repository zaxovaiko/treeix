//! App updates through tauri-plugin-updater: `latest.json` on the GitHub release, minisign-signed (docs/updater.md).
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
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let in_place = in_place::bundle().and_then(|bundle| in_place::install(&bundle, &bytes));
    #[cfg(not(target_os = "macos"))]
    let in_place: Result<(), String> = Err("macOS only".into());
    if let Err(e) = in_place {
        tracing::info!("replacing the whole bundle: {e}");
        update.install(&bytes).map_err(|e| e.to_string())?;
    }
    app.restart()
}

/// The plugin swaps in a new `Treeix.app`, and a Dock tile kept in the Dock points at the old folder, so the
/// updated app shows up as a second icon. Swapping only `Contents` keeps the folder the tile points at
#[cfg(target_os = "macos")]
mod in_place {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    /// `bytes` were verified against the update's signature by `Update::download`
    pub fn install(bundle: &Path, bytes: &[u8]) -> Result<(), String> {
        let temp = std::env::temp_dir();
        let device = |p: &Path| p.metadata().map(|m| m.dev()).ok();
        if device(&temp) != device(bundle) {
            return Err("temp dir is on another volume".into());
        }
        let staged = tempfile::Builder::new()
            .prefix("treeix-update")
            .tempdir_in(&temp)
            .map_err(|e| e.to_string())?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        // `Treeix.app/Contents/...`: the top folder's name may differ, only what is inside it counts
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let inner: PathBuf = entry
                .path()
                .map_err(|e| e.to_string())?
                .iter()
                .skip(1)
                .collect();
            if inner.as_os_str().is_empty() {
                continue;
            }
            let to = staged.path().join(inner);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&to).map_err(|e| e.to_string())?;
        }
        // The old Contents ends up in `staged`, removed on drop
        swap(&bundle.join("Contents"), &staged.path().join("Contents"))?;
        // LaunchServices re-reads Info.plist when the bundle's date changes
        let _ = std::process::Command::new("touch").arg(bundle).status();
        Ok(())
    }

    pub fn bundle() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        exe.ancestors()
            .nth(3)
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("not in an app bundle: {}", exe.display()))
    }

    fn swap(a: &Path, b: &Path) -> Result<(), String> {
        let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|e| e.to_string());
        let (a, b) = (c(a)?, c(b)?);
        // SAFETY: two valid NUL-terminated paths that outlive the call
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    #[cfg(test)]
    mod tests {
        use std::os::unix::fs::MetadataExt;

        #[test]
        fn swaps_contents_and_keeps_the_bundle_folder() {
            let root = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
            let bundle = root.path().join("Treeix.app");
            std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
            std::fs::write(bundle.join("Contents/MacOS/old"), "old").unwrap();
            let inode = bundle.metadata().unwrap().ino();

            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::fast(),
            ));
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o755);
            tar.append_data(&mut header, "Treeix.app/Contents/MacOS/new", &b"new"[..])
                .unwrap();
            let bytes = tar.into_inner().unwrap().finish().unwrap();

            super::install(&bundle, &bytes).unwrap();
            assert_eq!(bundle.metadata().unwrap().ino(), inode);
            assert_eq!(
                std::fs::read_to_string(bundle.join("Contents/MacOS/new")).unwrap(),
                "new"
            );
            assert!(!bundle.join("Contents/MacOS/old").exists());
        }
    }
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
