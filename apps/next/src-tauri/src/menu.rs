//! The macOS menu bar. Cmd+W, Cmd+T, Cmd+D and Cmd+K stay unbound: the frontend handles them per pane.
//! Custom items reach the frontend as the `menu` app event with their id.

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, Serialize)]
struct MenuAction<'a> {
    id: &'a str,
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: &str| {
        MenuItem::with_id(app, id, text, true, Some(accelerator))
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
        .item(&item(
            "command-palette",
            "Command Palette…",
            "CmdOrCtrl+Shift+P",
        )?)
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
