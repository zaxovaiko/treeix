//! Files the system hands to Treeix (Finder's Open With and double-click, a Linux file manager) open in its editor

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Opened files the page hasn't taken yet: it takes them once it loads and on every `files-opened`
#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

const EVENT: &str = "files-opened";

/// Queues the files among `paths` and brings the main window forward to show them
pub fn open(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let files: Vec<String> = paths
        .into_iter()
        .filter(|path| path.is_file())
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect();
    if files.is_empty() {
        return;
    }
    app.state::<Pending>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(files);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit_to("main", EVENT, ()) {
        tracing::error!("emit {EVENT}: {e}");
    }
}

/// What a launch names on its command line, against the folder it was started in; flags are skipped
pub fn from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .collect()
}

/// The opened files not shown yet, absolute
#[tauri::command]
#[specta::specta]
pub fn take_opened_files(pending: tauri::State<'_, Pending>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_args_skips_the_binary_and_flags() {
        let args = ["/bin/treeix", "-psn_0_123", "a.ts", "/abs/b.ts"].map(String::from);
        assert_eq!(
            from_args(&args, Path::new("/work")),
            [PathBuf::from("/work/a.ts"), PathBuf::from("/abs/b.ts")]
        );
    }
}
