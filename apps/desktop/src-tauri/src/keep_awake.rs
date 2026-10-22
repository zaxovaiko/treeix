//! Keep awake: an IOPMAssertion on macOS, `systemd-inhibit` on Linux. `settings.awake.mode` is the toggle; with
//! `untilAgentsFinish` the hold follows whether an agent session runs. "Lid closed" turns lid-close sleep off through
//! `pmset` and an administrator prompt, like the Electron app, and only ever restores what it changed

use crate::commands::KeepAwakeState;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use treeix_core::settings::{KeepAwakeMode, Settings};

#[derive(Default)]
pub struct KeepAwake(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    agents_running: bool,
    hold: Option<Hold>,
    /// Treeix turned lid-close sleep off and owes the restore
    lid_sleep_off: bool,
    last: Option<KeepAwakeState>,
}

/// Whether the assertion should be held now
pub fn wanted(settings: &Settings, agents_running: bool) -> bool {
    settings.features.awake
        && match settings.awake.mode {
            KeepAwakeMode::Off => false,
            KeepAwakeMode::On => true,
            KeepAwakeMode::UntilAgentsFinish => agents_running,
        }
}

impl KeepAwake {
    pub fn state(&self, settings: &Settings) -> KeepAwakeState {
        KeepAwakeState {
            on: settings.features.awake && settings.awake.mode != KeepAwakeMode::Off,
            active: self.0.lock().unwrap().hold.is_some(),
        }
    }

    /// Takes or drops the hold to match `settings` and the agents; `KeepAwakeState` goes out when it changed
    pub fn apply(&self, app: &AppHandle, settings: &Settings, agents_running: Option<bool>) {
        let mut inner = self.0.lock().unwrap();
        if let Some(running) = agents_running {
            inner.agents_running = running;
        }
        let want = wanted(settings, inner.agents_running);
        if want && inner.hold.is_none() {
            match Hold::take() {
                Ok(hold) => inner.hold = Some(hold),
                Err(e) => tracing::warn!("keep awake: {e}"),
            }
        } else if !want {
            inner.hold = None;
        }
        // Like Electron: lid-close sleep stays off between agent runs, each change costs a password prompt
        let lid_off = settings.awake.lid_closed && (want || inner.lid_sleep_off);
        if cfg!(target_os = "macos") && lid_off != inner.lid_sleep_off {
            match set_lid_sleep_off(lid_off) {
                Ok(()) => inner.lid_sleep_off = lid_off,
                Err(e) => tracing::warn!("lid sleep: {e}"),
            }
        }
        let state = KeepAwakeState {
            on: settings.features.awake && settings.awake.mode != KeepAwakeMode::Off,
            active: inner.hold.is_some(),
        };
        if inner.last.as_ref() != Some(&state) {
            inner.last = Some(state.clone());
            drop(inner);
            if let Err(e) = state.emit(app) {
                tracing::warn!("keep awake event: {e}");
            }
        }
    }

    /// On quit: lid-close sleep back on if Treeix turned it off; a Mac stuck awake in a bag is worse than a prompt
    pub fn restore(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.hold = None;
        if inner.lid_sleep_off && set_lid_sleep_off(false).is_ok() {
            inner.lid_sleep_off = false;
        }
    }
}

pub fn get(app: &AppHandle) -> &KeepAwake {
    app.state::<KeepAwake>().inner()
}

fn set_lid_sleep_off(off: bool) -> Result<(), String> {
    let script = format!(
        "do shell script \"pmset -a disablesleep {}\" with administrator privileges",
        u8::from(off)
    );
    let status = std::process::Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map_err(|e| e.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "cancelled".into())
}

/// The OS hold on idle sleep; dropping it lets the machine sleep again
#[cfg(target_os = "macos")]
struct Hold(objc2_io_kit::IOPMAssertionID);

#[cfg(target_os = "macos")]
impl Hold {
    fn take() -> Result<Self, String> {
        use objc2_core_foundation::CFString;
        use objc2_io_kit::{IOPMAssertionCreateWithName, kIOPMAssertionLevelOn};
        let kind = CFString::from_static_str("PreventUserIdleSystemSleep");
        let name = CFString::from_static_str("Treeix agents are working");
        let mut id = 0;
        // SAFETY: both strings live through the call and `id` is a valid out pointer
        let status = unsafe {
            IOPMAssertionCreateWithName(Some(&kind), kIOPMAssertionLevelOn, Some(&name), &mut id)
        };
        if status == 0 {
            Ok(Self(id))
        } else {
            Err(format!("IOPMAssertionCreateWithName failed: {status:#x}"))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for Hold {
    fn drop(&mut self) {
        objc2_io_kit::IOPMAssertionRelease(self.0);
    }
}

/// `systemd-inhibit` holding the lock for as long as its `sleep` child lives
#[cfg(not(target_os = "macos"))]
struct Hold(std::process::Child);

#[cfg(not(target_os = "macos"))]
impl Hold {
    fn take() -> Result<Self, String> {
        std::process::Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=Treeix",
                "--why=Agents are working",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(Self)
            .map_err(|e| format!("systemd-inhibit: {e}"))
    }
}

#[cfg(not(target_os = "macos"))]
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_decides_when_the_hold_is_wanted() {
        let mut settings = Settings::default();
        assert!(!wanted(&settings, false));
        assert!(wanted(&settings, true));
        settings.awake.mode = KeepAwakeMode::On;
        assert!(wanted(&settings, false));
        settings.features.awake = false;
        assert!(!wanted(&settings, true));
        settings.features.awake = true;
        settings.awake.mode = KeepAwakeMode::Off;
        assert!(!wanted(&settings, true));
    }
}
