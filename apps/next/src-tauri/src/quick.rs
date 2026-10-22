//! The quick terminal: a hidden window summoned over any app and space by a global chord.
//! On macOS it is a non-activating NSPanel so summoning it does not pull the main window forward; elsewhere an
//! always-on-top, undecorated, taskbar-less window. Both hide when they lose focus.

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const LABEL: &str = "quick";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?window=quick".into()),
    )
    .title("Quick Terminal")
    .inner_size(960.0, 480.0)
    .decorations(false)
    .resizable(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .visible(false)
    // A suspended webview stops acking, and the daemon then pauses the shell's output
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .build()?;
    #[cfg(target_os = "macos")]
    panel::convert(&window)?;
    #[cfg(not(target_os = "macos"))]
    window.clone().on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = window.hide();
        }
    });
    Ok(())
}

pub fn toggle(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    panel::toggle(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = tauri::Manager::get_webview_window(app, LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// The Electron app ships with no chord (the hotkey window is opt-in), so nothing is registered until settings set one
pub fn set_shortcut(
    app: &AppHandle,
    accelerator: Option<&str>,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all()?;
    match accelerator {
        Some(accelerator) => shortcuts.register(accelerator),
        None => Ok(()),
    }
}

#[cfg(target_os = "macos")]
// tauri_panel!'s event syntax requires the explicit `-> ()`
#[allow(clippy::unused_unit)]
mod panel {
    use super::LABEL;
    use std::sync::Arc;
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{
        CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel,
    };

    tauri_panel! {
        panel!(QuickPanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })

        panel_event!(QuickPanelEvents {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    pub fn convert(window: &WebviewWindow) -> tauri::Result<()> {
        let panel = window.to_panel::<QuickPanel>()?;
        panel.set_level(PanelLevel::Floating.value());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .into(),
        );
        if let Err(e) = panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()) {
            tracing::warn!("quick terminal stays an activating panel: {e:?}");
        }
        let events = QuickPanelEvents::new();
        let weak = Arc::downgrade(&panel);
        events.window_did_resign_key(move |_| {
            if let Some(panel) = weak.upgrade() {
                panel.hide();
            }
        });
        panel.set_event_handler(Some(events.as_ref()));
        Ok(())
    }

    pub fn toggle(app: &AppHandle) {
        let Ok(panel) = app.get_webview_panel(LABEL) else {
            return;
        };
        if panel.is_visible() {
            panel.hide();
        } else {
            panel.show_and_make_key();
        }
    }
}
