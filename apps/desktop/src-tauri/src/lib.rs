mod browser;
mod commands;
mod daemon;
mod keep_awake;
#[cfg(target_os = "macos")]
mod menu;
mod quick;
mod service;
mod tray;
mod types;
mod updater;
mod voice;

use std::io::Write;
use std::sync::Arc;
use tauri::Manager;
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
            set_quick_look,
            set_window_blur,
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
            // Phase 4: agents
            agent_usage,
            usage_limits,
            session_usage,
            session_ports,
            kill_port,
            // chat
            chat_create,
            chat_prompt,
            chat_cancel,
            chat_answer,
            chat_set_option,
            chat_list,
            chat_attach,
            chat_detach,
            chat_close,
            // MCP, tickets
            mcp_status,
            mcp_install,
            my_tickets,
            ticket_detail,
            notion_databases,
            // Phase 5: settings, secrets, system
            get_settings,
            update_settings,
            has_secret,
            set_secret,
            delete_secret,
            cli_tools,
            update_cli_tool,
            run_command,
            check_update,
            install_update,
            keep_awake,
            set_keep_awake,
            phone_status,
            set_phone,
            // Phase 6-7: routines
            routine_list,
            routine_put,
            routine_remove,
            routine_run_now,
            routine_runs,
            routine_cancel_run,
            routine_next_fires,
            // browser pane
            browser_open,
            browser_place,
            browser_close,
            browser_navigate,
            browser_go,
            browser_devtools,
            browser_cookie_profiles,
            browser_import_cookies,
            browser_clear_data,
            browser_dev_command,
            // plan pane, module graph
            plans_list,
            plan_read,
            graph_scan,
            // dictation, recording
            dictation_status,
            dictation_toggle,
            voice_model_download,
            voice_model_delete,
            voice_request_access,
            dictation_history,
            dictation_forget,
            recording_status,
            recording_start,
            recording_pause,
            recording_stop,
            recordings,
            recording_read,
            recording_delete,
        ])
        // Registering events is also what drops tauri's `TAURI_CHANNEL = null` placeholder type from the export
        .events(collect_events![
            FsEvent,
            UsageLimitsChanged,
            ChatsEvent,
            SettingsChanged,
            KeepAwakeState,
            RoutinesEvent,
            browser::BrowserEvent,
            voice::VoiceEvent
        ])
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

/// A Finder-launched app's stderr goes nowhere, and a panic under an AppKit callback aborts the app, so its message
/// and line are appended to data_dir/panic.log as well
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let path = treeix_proto::data_dir().join("panic.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let thread = std::thread::current();
            let _ = writeln!(
                file,
                "{at} thread '{}' {info}",
                thread.name().unwrap_or("?")
            );
        }
        default(info);
    }));
}

pub fn run() {
    log_panics();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            // The quick terminal is tracked too, so the height it was dragged to survives a restart; toggling re-places it
            tauri_plugin_window_state::Builder::new()
                // A window hidden at quit must not come back invisible
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
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
            specta.mount_events(app);
            let daemon = Arc::new(daemon::Daemon::default());
            app.manage(daemon.clone());
            tauri::async_runtime::spawn(daemon.run(app.handle().clone()));
            // Built here, not from tauri.conf.json, to be transparent on macOS only: Settings > Appearance > Opacity
            // shows the desktop through it, and a transparent Linux webview paints its own fill
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .transparent(cfg!(target_os = "macos"))
                .build()?;
            quick::create(app.handle())?;
            quick::setup(app.handle());
            commands::mcp::start(app.handle());
            commands::system::setup(app.handle());
            voice::setup(app.handle());
            // macOS stops drawing frames in a covered window, and the runners wait on frames
            if let (Some(_), Some(window)) = (autorun(), app.get_webview_window("main")) {
                window.set_always_on_top(true)?;
                window.set_visible_on_all_workspaces(true)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                commands::system::exit(app);
                voice::exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    /// `cargo test -p treeix-app export_bindings` regenerates src/ipc/bindings.ts without starting the app
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta()).unwrap();
    }
}
