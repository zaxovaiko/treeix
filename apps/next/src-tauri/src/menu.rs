//! The macOS menu bar. Cmd+W, Cmd+T, Cmd+D and Cmd+K stay unbound: the frontend handles them per pane.
//! Custom items reach the frontend as the `menu` app event with their id (CommandId in src/shell/shortcuts.ts).
//! Their chords belong to the menu: the frontend leaves them alone inside Tauri (menuChord in src/shell/shortcuts.ts).
//! A chord rebound in settings.keys moves here too, '' unbinds it; `rebind` rebuilds the menu after a settings save.

use serde::Serialize;
use std::collections::BTreeMap;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, Serialize)]
struct MenuAction<'a> {
    id: &'a str,
}

/// The chord for a menu item: the settings.keys override (accelerator format, '' unbinds), else the default
fn chord<'a>(keys: &'a BTreeMap<String, String>, id: &str, default: &'a str) -> Option<&'a str> {
    match keys.get(id) {
        Some(key) if key.is_empty() => None,
        Some(key) => Some(key),
        None => Some(default),
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let keys = treeix_core::settings::load(&treeix_proto::data_dir()).keys;
    let item = |id: &str, text: &str, default: &str| {
        MenuItem::with_id(app, id, text, true, chord(&keys, id, default))
    };
    let app_menu = SubmenuBuilder::new(app, "Treeix")
        .about(None)
        .separator()
        .item(&item("settings", "Settings…", "CmdOrCtrl+,")?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    // Predefined items so WKWebView gets the native clipboard and undo shortcuts
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-sidebar", "Toggle Sidebar", "CmdOrCtrl+\\")?)
        .item(&item("palette", "Command Palette…", "CmdOrCtrl+Shift+P")?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &view, &window])
        .build()
}

/// Settings were saved: the menu picks up rebound chords
pub fn rebind<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = build(app).and_then(|menu| app.set_menu(menu)) {
        tracing::warn!("menu rebind: {e}");
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if let Err(e) = app.emit(
        "menu",
        MenuAction {
            id: event.id().as_ref(),
        },
    ) {
        tracing::error!("emit menu: {e}");
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
            chord(&keys, "palette", "CmdOrCtrl+Shift+P"),
            Some("Shift+Super+KeyO")
        );
        assert_eq!(chord(&keys, "settings", "CmdOrCtrl+,"), None);
        assert_eq!(
            chord(&keys, "toggle-sidebar", "CmdOrCtrl+\\"),
            Some("CmdOrCtrl+\\")
        );
    }
}
