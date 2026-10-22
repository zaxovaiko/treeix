//! The tray icon: plan usage next to it (`settings.usage.tray`, `off` removes it) and the sessions that need you in
//! its menu, with Open, Check for Updates and Quit

use std::sync::Mutex;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use treeix_core::agents::limits::{AgentLimits, UsageLimits};
use treeix_core::settings::{Settings, TrayLabel};

const ID: &str = "treeix";
const OPEN: &str = "tray-open";
const UPDATE: &str = "tray-update";
const QUIT: &str = "tray-quit";

#[derive(Default)]
pub struct Tray(Mutex<State>);

#[derive(Default, Clone)]
struct State {
    /// Titles of the sessions that wait for the user
    needs: Vec<String>,
    limits: UsageLimits,
}

impl Tray {
    pub fn set_needs(&self, app: &AppHandle, needs: Vec<String>) {
        let changed = {
            let mut state = self.0.lock().unwrap();
            let changed = state.needs != needs;
            state.needs = needs;
            changed
        };
        if changed {
            self.render(app, &load_settings());
        }
    }

    pub fn set_limits(&self, app: &AppHandle, limits: UsageLimits) {
        self.0.lock().unwrap().limits = limits;
        self.render(app, &load_settings());
    }

    pub fn render(&self, app: &AppHandle, settings: &Settings) {
        let state = self.0.lock().unwrap().clone();
        if let Err(e) = render(app, settings, &state) {
            tracing::warn!("tray: {e}");
        }
    }
}

pub fn get(app: &AppHandle) -> &Tray {
    app.state::<Tray>().inner()
}

fn load_settings() -> Settings {
    treeix_core::settings::load(&treeix_proto::data_dir())
}

fn render(app: &AppHandle, settings: &Settings, state: &State) -> tauri::Result<()> {
    if settings.usage.tray == TrayLabel::Off {
        app.remove_tray_by_id(ID);
        return Ok(());
    }
    let menu = menu(app, &state.needs)?;
    let title = title(settings, state);
    let tooltip = match state.needs.len() {
        0 => "Treeix".to_string(),
        1 => "Treeix: 1 session needs you".to_string(),
        n => format!("Treeix: {n} sessions need you"),
    };
    let tray = match app.tray_by_id(ID) {
        Some(tray) => tray,
        None => {
            let mut builder = TrayIconBuilder::with_id(ID)
                .show_menu_on_left_click(true)
                .on_menu_event(on_menu);
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?
        }
    };
    tray.set_menu(Some(menu))?;
    tray.set_title(title)?;
    tray.set_tooltip(Some(tooltip))
}

/// What sits next to the icon: a dot with the count of sessions that need you, then the chosen usage
fn title(settings: &Settings, state: &State) -> Option<String> {
    let limits = (settings.features.usage)
        .then(|| state.limits.claude.or(state.limits.codex))
        .flatten();
    let percent = |window: Option<treeix_core::agents::limits::LimitWindow>| {
        window.map(|w| format!("{}%", w.used_percent.round()))
    };
    let usage = limits.and_then(|l: AgentLimits| match settings.usage.tray {
        TrayLabel::Weekly => percent(l.weekly),
        TrayLabel::FiveHour => percent(l.five_hour),
        // ponytail: rings as text, draw them into the icon if people want the picture
        TrayLabel::Rings => match (percent(l.five_hour), percent(l.weekly)) {
            (Some(five), Some(week)) => Some(format!("{five} · {week}")),
            (five, week) => five.or(week),
        },
        TrayLabel::Icon | TrayLabel::Off => None,
    });
    let needs = (!state.needs.is_empty()).then(|| format!("● {}", state.needs.len()));
    let parts: Vec<String> = [needs, usage].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join("  "))
}

fn menu(app: &AppHandle, needs: &[String]) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    if !needs.is_empty() {
        items.push(Box::new(MenuItem::new(
            app,
            "Need you",
            false,
            None::<&str>,
        )?));
        for (i, title) in needs.iter().enumerate() {
            items.push(Box::new(MenuItem::with_id(
                app,
                format!("{OPEN}-{i}"),
                title,
                true,
                None::<&str>,
            )?));
        }
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    items.push(Box::new(MenuItem::with_id(
        app,
        OPEN,
        "Open Treeix",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        UPDATE,
        "Check for Updates…",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        QUIT,
        "Quit Treeix",
        true,
        None::<&str>,
    )?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(Box::as_ref).collect();
    Menu::with_items(app, &refs)
}

fn on_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        UPDATE => {
            tauri::async_runtime::spawn(crate::updater::check_and_ask(app.clone(), false));
        }
        QUIT => app.exit(0),
        // Open, or a session that needs you: bring the main window up
        id if id.starts_with(OPEN) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use treeix_core::agents::limits::LimitWindow;

    fn state(needs: usize) -> State {
        let window = |used_percent| {
            Some(LimitWindow {
                used_percent,
                resets_at: None,
            })
        };
        State {
            needs: vec!["claude".into(); needs],
            limits: UsageLimits {
                claude: Some(AgentLimits {
                    five_hour: window(12.4),
                    weekly: window(41.6),
                    updated_at: None,
                }),
                codex: None,
            },
        }
    }

    #[test]
    fn the_title_shows_what_settings_pick() {
        let mut settings = Settings::default();
        assert_eq!(title(&settings, &state(0)), None);
        assert_eq!(title(&settings, &state(2)).as_deref(), Some("● 2"));
        settings.usage.tray = TrayLabel::Weekly;
        assert_eq!(title(&settings, &state(0)).as_deref(), Some("42%"));
        settings.usage.tray = TrayLabel::Rings;
        assert_eq!(
            title(&settings, &state(1)).as_deref(),
            Some("● 1  12% · 42%")
        );
        settings.features.usage = false;
        assert_eq!(title(&settings, &state(0)), None);
    }
}
