//! The hotkey window: a global chord shows and hides the main window over any app and space.

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::cell::RefCell;
use tauri::{AppHandle, Manager};

/// Blurs what shows through the see-through main window; Linux windows are never see-through
pub fn set_window_blur(window: &tauri::WebviewWindow, blur: bool) {
    #[cfg(target_os = "macos")]
    blur::set(window, blur);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, blur);
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
fn toggle(app: &AppHandle) {
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
/// A chord takes the app off the Dock and the app switcher, so the chord is the way back
pub fn set_shortcut(app: &AppHandle, accelerator: Option<&str>) -> Result<(), String> {
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
    {
        let hotkey_window = chorded && registered.is_ok();
        let _ = app.set_activation_policy(if hotkey_window {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        });
        // A hotkey window has square corners and no traffic lights; decorations back on drop the overlay title bar
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_decorations(!hotkey_window);
            if !hotkey_window {
                let _ = main.set_title_bar_style(tauri::TitleBarStyle::Overlay);
            }
        }
    }
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
mod blur {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    const BLUR_RADIUS: i32 = 24;

    // The window server's backdrop blur, the one Terminal, iTerm2 and Ghostty use; AppKit has no public call for it
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSMainConnectionID() -> i32;
        fn CGSSetWindowBackgroundBlurRadius(connection: i32, window: i32, radius: i32) -> i32;
    }

    pub fn set(window: &tauri::WebviewWindow, blur: bool) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ns_window) = target.ns_window() else {
                return;
            };
            // SAFETY: tauri's live NSWindow, used on the main thread
            unsafe {
                let number: isize = msg_send![&*ns_window.cast::<AnyObject>(), windowNumber];
                CGSSetWindowBackgroundBlurRadius(
                    CGSMainConnectionID(),
                    number as i32,
                    if blur { BLUR_RADIUS } else { 0 },
                );
            }
        });
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
