mod commands;
mod daemon;
#[cfg(target_os = "macos")]
mod menu;
mod quick;
mod types;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;
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
            get_ui,
            put_ui,
            places,
            home_dir,
            set_quick_shortcut,
            bench_report,
        ])
        // Registering events (none) is what drops tauri's `TAURI_CHANNEL = null` placeholder type from the export
        .events(collect_events![])
}

#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) {
    use specta_typescript::{BigIntExportBehavior, Typescript};
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/bindings.ts");
    // Only works from the checkout that built the binary; a copied debug build has no source tree to write to
    if let Err(e) = builder.export(
        Typescript::default()
            .header("// @ts-nocheck")
            .bigint(BigIntExportBehavior::Number),
        path,
    ) {
        tracing::warn!("typescript bindings not exported: {e}");
    }
}

/// `TREEIX_BENCH=1` runs the in-app terminal bench on start (perf CI, Phase 0 gate); results land in data_dir/bench-*.json
fn bench_run() -> bool {
    std::env::var_os("TREEIX_BENCH").is_some()
}

/// Enables the bench module (one reload), then runs it once it has loaded
const BENCH_SCRIPT: &str = "if (localStorage.getItem('treeix.bench') !== '1') { localStorage.setItem('treeix.bench', '1'); location.reload() } \
else (async () => { while (!window.__treeixBench) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 2000)); await window.__treeixBench() })()";

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let specta = specta();
    #[cfg(debug_assertions)]
    export_bindings(&specta);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
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
        .on_page_load(|webview, payload| {
            if bench_run()
                && webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                let _ = webview.eval(BENCH_SCRIPT);
            }
        })
        .setup(move |app| {
            let daemon = Arc::new(daemon::Daemon::default());
            app.manage(daemon.clone());
            tauri::async_runtime::spawn(daemon.run(app.handle().clone()));
            quick::create(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri app failed to start");
}
