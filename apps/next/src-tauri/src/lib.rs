mod commands;
mod daemon;
#[cfg(target_os = "macos")]
mod menu;
mod quick;
mod service;
mod types;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::StateFlags;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands, collect_events};

fn specta() -> Builder<tauri::Wry> {
    use commands::*;
    Builder::<tauri::Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            hello,
            sessions,
            create,
            attach,
            detach,
            write,
            write_bytes,
            resize,
            ack,
            kill,
            remove,
            restart,
            clear,
            get_ui,
            put_ui,
            places,
            home_dir,
            set_quick_shortcut,
            autorun,
            autorun_done,
            // Phase 3: git
            list_worktrees,
            git_status,
            diff,
            read_file_at,
            file_log,
            commit_diff,
            list_branches,
            check_branch_name,
            create_branch,
            delete_branch,
            add_worktree,
            remove_worktree,
            prune_worktrees,
            discard_changes,
            // files, search, watch
            list_files,
            list_directory,
            read_file,
            save_file,
            create_path,
            rename_path,
            trash_path,
            reveal_in_finder,
            open_path,
            open_url,
            search_text,
            watch,
            unwatch,
            // pull requests
            list_pull_requests,
            pr_checks,
            merge_pull_request,
            pr_providers,
            // local history, closed sessions
            list_history,
            read_history,
            session_history,
            forget_session,
        ])
        // Registering events is also what drops tauri's `TAURI_CHANNEL = null` placeholder type from the export
        .events(collect_events![FsEvent])
}

#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) -> Result<(), specta_typescript::ExportError> {
    use specta_typescript::{BigIntExportBehavior, Typescript};
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/bindings.ts");
    builder.export(
        Typescript::default()
            .header("// @ts-nocheck")
            .bigint(BigIntExportBehavior::Number),
        path,
    )
}

/// `TREEIX_AUTORUN=<name>` runs that frontend runner once the window loads, saves its report and quits (perf CI, e2e)
fn autorun() -> Option<String> {
    std::env::var("TREEIX_AUTORUN")
        .ok()
        .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()))
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let specta = specta();
    // Only works from the checkout that built the binary; a copied debug build has no source tree to write to
    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings(&specta) {
        tracing::warn!("typescript bindings not exported: {e}");
    }

    let builder = tauri::Builder::default()
        // First: a second launch hands over to this one before it builds anything
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[quick::LABEL])
                // A window hidden at quit must not come back invisible
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        quick::toggle(app);
                    }
                })
                .build(),
        );
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_nspanel::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event);

    builder
        .invoke_handler(specta.invoke_handler())
        .on_page_load(daemon::on_page_load)
        .setup(move |app| {
            let daemon = Arc::new(daemon::Daemon::default());
            app.manage(daemon.clone());
            tauri::async_runtime::spawn(daemon.run(app.handle().clone()));
            quick::create(app.handle())?;
            // macOS stops drawing frames in a covered window, and the runners wait on frames
            if let (Some(_), Some(window)) = (autorun(), app.get_webview_window("main")) {
                window.set_always_on_top(true)?;
                window.set_visible_on_all_workspaces(true)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri app failed to start");
}

#[cfg(test)]
mod tests {
    /// `cargo test -p treeix-app export_bindings` regenerates src/ipc/bindings.ts without starting the app
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta()).unwrap();
    }
}
