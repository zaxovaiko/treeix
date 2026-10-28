//! The quick terminal: a hidden window summoned over any app and space by a global chord.
//! On macOS it is a non-activating NSPanel so summoning it does not pull the main window forward; elsewhere an
//! always-on-top, undecorated, taskbar-less window. Both drop from the top edge of the screen under the pointer,
//! as wide as it, and hide when they lose focus.

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "quick";
/// The chord shows and hides the main window instead of the quick terminal
static WHOLE_APP: AtomicBool = AtomicBool::new(false);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?window=quick".into()),
    )
    .title("Quick Terminal")
    // The height the user drags it to is kept; the width always spans the screen
    .inner_size(960.0, 420.0)
    .decorations(false)
    .resizable(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .visible(false)
    // See-through comes from the page's background alpha, so the backdrop blur has transparent pixels to show through
    .transparent(cfg!(target_os = "macos"))
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
    if WHOLE_APP.load(Ordering::Relaxed) {
        return toggle_main(app);
    }
    #[cfg(target_os = "macos")]
    panel::toggle(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = tauri::Manager::get_webview_window(app, LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            drop_down(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn drop_down(window: &tauri::WebviewWindow) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|p| window.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(size)) = (monitor, window.outer_size()) else {
        return;
    };
    let area = monitor.work_area();
    let _ = window.set_position(area.position);
    let _ = window.set_size(tauri::PhysicalSize::new(
        area.size.width,
        size.height.min(area.size.height),
    ));
}

/// Blurs what shows through a see-through window, the main one too; Linux windows are never see-through
pub fn set_window_blur(window: &tauri::WebviewWindow, blur: bool) {
    #[cfg(target_os = "macos")]
    panel::set_window_blur(window, blur);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, blur);
}

/// Whether it slides in and whether what shows through is blurred; Linux windows have neither, so it ignores them
pub fn set_look(app: &AppHandle, animate: bool, blur: bool) {
    #[cfg(target_os = "macos")]
    panel::set_look(app, animate, blur);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, animate, blur);
}

// global-hotkey directly, not tauri-plugin-global-shortcut: the plugin pins global-hotkey 0.8, which has no
// IntlBackslash, the § key on Mac ISO keyboards
thread_local! {
    /// macOS needs the manager created and used on the main thread, so it lives there with the chord it holds
    static CHORD: RefCell<Option<(GlobalHotKeyManager, Option<HotKey>)>> = const { RefCell::new(None) };
}

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state == HotKeyState::Pressed {
            toggle(&app);
        }
    }));
}

/// In front, it hides the app (macOS hands focus back to the app before it); else it comes forward
fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let in_front = window.is_visible().unwrap_or(false)
        && window.is_focused().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false);
    if !in_front {
        // The app was hidden on the last toggle; its window shows without the app unhidden, but set_focus skips
        // invisible windows, so it came forward without activating and keys went to the app before it
        #[cfg(target_os = "macos")]
        let _ = app.show();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
    #[cfg(not(target_os = "macos"))]
    let _ = window.hide();
}

/// The app ships with no chord (the hotkey window is opt-in), so nothing is registered until settings set one.
/// A chord that toggles the whole app takes it off the Dock and the app switcher, so the chord is the way back
pub fn set_shortcut(
    app: &AppHandle,
    accelerator: Option<&str>,
    whole_app: bool,
) -> Result<(), String> {
    WHOLE_APP.store(whole_app, Ordering::Relaxed);
    let hotkey = accelerator
        .map(str::parse::<HotKey>)
        .transpose()
        .map_err(|e| e.to_string())?;
    let chorded = hotkey.is_some();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(CHORD.with_borrow_mut(|chord| swap(chord, hotkey)));
    })
    .map_err(|e| e.to_string())?;
    let registered = rx.recv().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(if whole_app && chorded && registered.is_ok() {
        tauri::ActivationPolicy::Accessory
    } else {
        tauri::ActivationPolicy::Regular
    });
    #[cfg(not(target_os = "macos"))]
    let _ = chorded;
    registered
}

fn swap(
    chord: &mut Option<(GlobalHotKeyManager, Option<HotKey>)>,
    hotkey: Option<HotKey>,
) -> Result<(), String> {
    if chord.is_none() {
        *chord = Some((GlobalHotKeyManager::new().map_err(|e| e.to_string())?, None));
    }
    let Some((manager, current)) = chord else {
        return Ok(());
    };
    if let Some(old) = current.take() {
        manager.unregister(old).map_err(|e| e.to_string())?;
    }
    if let Some(hotkey) = hotkey {
        manager.register(hotkey).map_err(|e| e.to_string())?;
        *current = Some(hotkey);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
// tauri_panel!'s event syntax requires the explicit `-> ()`
#[allow(clippy::unused_unit)]
mod panel {
    use super::LABEL;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{AppHandle, WebviewWindow};
    // tauri_panel! brings MainThreadMarker, NSEvent, NSWindow, NSRect, NSPoint and NSSize in
    use tauri_nspanel::objc2;
    use tauri_nspanel::objc2_app_kit::NSScreen;
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

    static ANIMATE: AtomicBool = AtomicBool::new(true);
    /// How far above its place it starts; AppKit moves windows at about 150px per 0.2s, so this slide takes ~0.1s
    const SLIDE: f64 = 72.0;
    const BLUR_RADIUS: i32 = 24;

    // The window server's backdrop blur, the one Terminal, iTerm2 and Ghostty use; AppKit has no public call for it
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSMainConnectionID() -> i32;
        fn CGSSetWindowBackgroundBlurRadius(connection: i32, window: i32, radius: i32) -> i32;
    }

    /// On the main thread
    fn set_blur(window: &NSWindow, blur: bool) {
        let number = window.windowNumber() as i32;
        // SAFETY: on the main thread, with a live window's number
        unsafe {
            CGSSetWindowBackgroundBlurRadius(
                CGSMainConnectionID(),
                number,
                if blur { BLUR_RADIUS } else { 0 },
            )
        };
    }

    pub fn set_look(app: &AppHandle, animate: bool, blur: bool) {
        ANIMATE.store(animate, Ordering::Relaxed);
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Ok(panel) = app.get_webview_panel(LABEL) {
                set_blur(panel.as_panel(), blur);
            }
        });
    }

    pub fn set_window_blur(window: &WebviewWindow, blur: bool) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns_window) = target.ns_window() {
                // SAFETY: tauri's live NSWindow, used on the main thread
                set_blur(unsafe { &*ns_window.cast::<NSWindow>() }, blur);
            }
        });
    }

    pub fn convert(window: &WebviewWindow) -> tauri::Result<()> {
        let panel = window.to_panel::<QuickPanel>()?;
        // Status: over every app's windows, the Dock and the menu bar
        panel.set_level(PanelLevel::Status.value());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .into(),
        );
        match panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()) {
            Ok(()) => prevent_activation(panel.as_panel()),
            Err(e) => tracing::warn!("quick terminal stays an activating panel: {e:?}"),
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

    /// AppKit keeps the window server's activation flag from the window's creation, so a panel made nonactivating
    /// afterwards shows as key on its first summon but gets no key events; the private setter syncs the flag
    fn prevent_activation(window: &NSWindow) {
        let selector = objc2::sel!(_setPreventsActivation:);
        // SAFETY: on the main thread with a live window, and the selector is checked before it is sent
        unsafe {
            let responds: bool = objc2::msg_send![window, respondsToSelector: selector];
            if responds {
                let _: () = objc2::msg_send![window, _setPreventsActivation: true];
            } else {
                tracing::warn!(
                    "quick terminal may miss keys on its first summon: no _setPreventsActivation:"
                );
            }
        }
    }

    pub fn toggle(app: &AppHandle) {
        let Ok(panel) = app.get_webview_panel(LABEL) else {
            return;
        };
        if panel.is_visible() {
            panel.hide();
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return panel.show_and_make_key();
        };
        let window: &NSWindow = panel.as_panel();
        let Some(area) = screen_under_pointer(mtm) else {
            return panel.show_and_make_key();
        };
        let height = window.frame().size.height.min(area.size.height);
        let top = area.origin.y + area.size.height;
        let at = |y| {
            NSRect::new(
                NSPoint::new(area.origin.x, y),
                NSSize::new(area.size.width, height),
            )
        };
        // Slides down a little from above its place, so its size, and the shell's grid, stay put while it moves
        let slide = if ANIMATE.load(Ordering::Relaxed) {
            SLIDE.min(height)
        } else {
            0.0
        };
        window.setFrame_display(at(top - height + slide), false);
        panel.show_and_make_key();
        if slide > 0.0 {
            window.setFrame_display_animate(at(top - height), true, true);
        }
    }

    /// The visible frame (below the menu bar, beside the Dock) of the screen the pointer is on
    fn screen_under_pointer(mtm: MainThreadMarker) -> Option<NSRect> {
        let pointer = NSEvent::mouseLocation();
        let inside = |r: NSRect| {
            pointer.x >= r.origin.x
                && pointer.x < r.origin.x + r.size.width
                && pointer.y >= r.origin.y
                && pointer.y < r.origin.y + r.size.height
        };
        NSScreen::screens(mtm)
            .iter()
            .find(|s| inside(s.frame()))
            .or_else(|| NSScreen::mainScreen(mtm))
            .map(|s| s.visibleFrame())
    }
}

#[cfg(test)]
mod tests {
    use super::HotKey;

    #[test]
    fn parses_chords_the_settings_recorder_makes() {
        for accelerator in [
            "Control+Backquote",
            "Control+IntlBackslash",
            "IntlBackslash",
            "Shift+Super+KeyT",
            "F5",
        ] {
            assert!(accelerator.parse::<HotKey>().is_ok(), "{accelerator}");
        }
    }
}
