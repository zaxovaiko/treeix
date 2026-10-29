//! The macOS menu bar: every app command, so each can be found and its chord read off the menu.
//! Cmd+W, Cmd+T, Cmd+D and Cmd+K stay unbound by default: the frontend handles them per pane.
//! Custom items reach the key window's frontend as the `menu` event with their id (CommandId in src/shell/shortcuts.ts).
//! Their chords belong to the menu: the frontend leaves them alone inside Tauri (menuChord in src/shell/shortcuts.ts).
//! A chord rebound in settings.keys moves here too, '' unbinds it; `rebind` rebuilds the menu after a settings save.

use serde::Serialize;
use std::collections::BTreeMap;
use tauri::menu::{
    HELP_SUBMENU_ID, Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Runtime};

/// Handled here rather than in the frontend
const CHECK_UPDATE: &str = "check-update";
/// Not the predefined item: the webview is a child of the window (tauri `unstable`), so wry hands every Cmd chord to
/// the menu before the page sees it (tauri#9426), and AppKit's selectAll: only selects Monaco's hidden textarea.
/// This one runs selectAll: for inputs and the browser pane, then the frontend's editor selects all (panes/file/TextFile.tsx)
const SELECT_ALL: &str = "select-all";

#[derive(Clone, Serialize)]
struct MenuAction<'a> {
    id: &'a str,
}

/// The chord for a menu item: the settings.keys override (accelerator format, '' unbinds), else the default
fn chord<'a>(
    keys: &'a BTreeMap<String, String>,
    id: &str,
    default: Option<&'a str>,
) -> Option<&'a str> {
    match keys.get(id) {
        Some(key) if key.is_empty() => None,
        Some(key) => Some(key),
        None => default,
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = treeix_core::settings::load(&treeix_proto::data_dir());
    let keys = &settings.keys;
    // Off while its feature is: the frontend ignores the command then anyway
    let gated = |id: &str, text: &str, default: Option<&str>, on: bool| {
        MenuItem::with_id(app, id, text, on, chord(keys, id, default))
    };
    let item = |id: &str, text: &str, default: Option<&str>| gated(id, text, default, true);
    let app_menu = SubmenuBuilder::new(app, "Treeix")
        .about(None)
        .item(&item(CHECK_UPDATE, "Check for Updates…", None)?)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-shell", "New Shell", None)?)
        .item(&item(
            "new-claude",
            "New Claude",
            Some("CmdOrCtrl+Shift+C"),
        )?)
        .item(&item("new-codex", "New Codex", Some("CmdOrCtrl+Shift+X"))?)
        .separator()
        .item(&item("open-folder", "Open Folder…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&gated(
            "record",
            "Record a Meeting",
            Some("CmdOrCtrl+Shift+R"),
            settings.features.recording,
        )?)
        .separator()
        .item(&item("close-pane", "Close Pane", None)?)
        .item(&item(
            "reopen-tab",
            "Reopen Closed Tab",
            Some("CmdOrCtrl+Shift+T"),
        )?)
        .build()?;
    // Predefined items so WKWebView gets the native clipboard and undo shortcuts
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&MenuItem::with_id(
            app,
            SELECT_ALL,
            "Select All",
            true,
            Some("CmdOrCtrl+A"),
        )?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            "palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .item(&item(
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&gated(
            "module-graph",
            "Module Graph",
            Some("CmdOrCtrl+Shift+G"),
            settings.features.graph,
        )?)
        .separator()
        .item(&item("toggle-tabs", "Tabs on Top or on the Side", None)?)
        .item(&item("toggle-theme", "Light or Dark", None)?)
        .separator()
        .item(&item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .separator()
        .fullscreen()
        .build()?;
    let pane = SubmenuBuilder::new(app, "Pane")
        .item(&item("split-right", "Split Right", None)?)
        .item(&item(
            "split-down",
            "Split Down",
            Some("CmdOrCtrl+Shift+D"),
        )?)
        .separator()
        .item(&item(
            "focus-left",
            "Focus Left",
            Some("CmdOrCtrl+Alt+Left"),
        )?)
        .item(&item(
            "focus-right",
            "Focus Right",
            Some("CmdOrCtrl+Alt+Right"),
        )?)
        .item(&item("focus-up", "Focus Up", Some("CmdOrCtrl+Alt+Up"))?)
        .item(&item(
            "focus-down",
            "Focus Down",
            Some("CmdOrCtrl+Alt+Down"),
        )?)
        .build()?;
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item("next-tab", "Next Tab", Some("CmdOrCtrl+Shift+]"))?)
        .item(&item(
            "prev-tab",
            "Previous Tab",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .build()?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", None)?)
        .item(&item("changelog", "Changelog", None)?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &pane, &window, &help])
        .build()
}

/// Settings were saved: the menu picks up rebound chords
pub fn rebind<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = build(app).and_then(|menu| app.set_menu(menu)) {
        tracing::warn!("menu rebind: {e}");
    }
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == CHECK_UPDATE {
        tauri::async_runtime::spawn(crate::updater::check_and_ask(app.clone(), false));
        return;
    }
    if event.id() == SELECT_ALL {
        native_select_all();
    }
    if let Err(e) = app.emit_to(
        "main",
        "menu",
        MenuAction {
            id: event.id().as_ref(),
        },
    ) {
        tracing::error!("emit menu: {e}");
    }
}

/// What the predefined Select All sends: a nil target walks the key window's responder chain
fn native_select_all() {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    let Some(class) = AnyClass::get(c"NSApplication") else {
        return;
    };
    let nil = std::ptr::null_mut::<AnyObject>();
    // SAFETY: menu events arrive on the main thread, and sendAction:to:from: takes a selector and two nil objects
    unsafe {
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        let _: Bool = msg_send![app, sendAction: sel!(selectAll:), to: nil, from: nil];
    }
}

#[cfg(test)]
mod tests {
    use super::chord;
    use std::collections::BTreeMap;

    #[test]
    fn settings_keys_rebind_and_unbind_menu_chords() {
        let keys = BTreeMap::from([
            ("palette".to_owned(), "Shift+Super+KeyO".to_owned()),
            ("settings".to_owned(), String::new()),
        ]);
        assert_eq!(
            chord(&keys, "palette", Some("CmdOrCtrl+Shift+P")),
            Some("Shift+Super+KeyO")
        );
        assert_eq!(chord(&keys, "settings", Some("CmdOrCtrl+,")), None);
        assert_eq!(
            chord(&keys, "toggle-sidebar", Some("CmdOrCtrl+\\")),
            Some("CmdOrCtrl+\\")
        );
        let new_shell = BTreeMap::from([("new-shell".to_owned(), "Super+KeyN".to_owned())]);
        assert_eq!(chord(&new_shell, "new-shell", None), Some("Super+KeyN"));
        assert_eq!(chord(&keys, "new-shell", None), None);
    }
}
