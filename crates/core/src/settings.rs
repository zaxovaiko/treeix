//! App settings in `<data dir>/settings.json`. The app owns the file; ptyd only reads the terminal fields.
//! Missing or unknown fields fall back to defaults, so old files keep loading. Secrets are not here (secrets.rs)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Each feature's on/off switch; off hides everything it adds (panels, settings, palette, status items)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Features {
    /// Usage pill, plan limits and the agent usage popover
    pub usage: bool,
    pub ports: bool,
    pub chat: bool,
    pub mcp: bool,
    pub jira: bool,
    pub notion: bool,
    pub prs: bool,
    pub awake: bool,
    /// One prompt, several agents, a worktree each
    pub race: bool,
}

impl Default for Features {
    fn default() -> Self {
        Self {
            usage: true,
            ports: true,
            chat: true,
            mcp: true,
            jira: false,
            notion: false,
            prs: true,
            awake: true,
            race: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    /// Theme name (features.ts THEMES) used in dark mode
    pub dark_theme: String,
    pub light_theme: String,
    /// Switch between them with the OS
    pub follow_system: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            dark_theme: "Neutral".into(),
            light_theme: "Light".into(),
            follow_system: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Terminal {
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f64,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    /// Lines kept above the screen
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub option_as_meta: bool,
    /// None runs the login shell from the user database
    pub shell: Option<String>,
    pub login_shell: bool,
    pub confirm_quit: bool,
}

impl Default for Terminal {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".into(),
            font_size: 12,
            line_height: 1.2,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            scrollback: 10_000,
            copy_on_select: false,
            option_as_meta: true,
            shell: None,
            login_shell: true,
            confirm_quit: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentView {
    Terminal,
    Chat,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Agents {
    /// `--dangerously-skip-permissions`
    pub skip_permissions_claude: bool,
    /// `--dangerously-bypass-approvals-and-sandbox`
    pub skip_permissions_codex: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Chats {
    /// What New Claude / New Codex session opens
    pub default_view: AgentView,
    /// Max width of the message column, px
    pub width: u32,
    pub show_thinking: bool,
    /// Notify when a turn ends or asks for permission out of sight
    pub notify: bool,
}

impl Default for Chats {
    fn default() -> Self {
        Self {
            default_view: AgentView::Terminal,
            width: 760,
            show_thinking: true,
            notify: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LimitWindowName {
    FiveHour,
    Weekly,
}

/// What sits next to the tray icon
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrayLabel {
    /// No tray icon
    Off,
    Icon,
    Weekly,
    FiveHour,
    Rings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Usage {
    /// The pill in the title bar
    pub pill: bool,
    /// Which window the pill shows
    pub window: LimitWindowName,
    pub tray: TrayLabel,
}

impl Default for Usage {
    fn default() -> Self {
        Self {
            pill: true,
            window: LimitWindowName::Weekly,
            tray: TrayLabel::Icon,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Jira {
    pub jql: String,
}

impl Default for Jira {
    fn default() -> Self {
        Self {
            jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Notion {
    /// Database the tickets come from; the token is in the keyring
    pub database: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Prs {
    pub refresh_minutes: u32,
}

impl Default for Prs {
    fn default() -> Self {
        Self { refresh_minutes: 5 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwakeMode {
    Off,
    On,
    /// Held while any agent session is running
    UntilAgentsFinish,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Awake {
    /// What the toggle turns on
    pub mode: KeepAwakeMode,
    /// Also with the lid closed (macOS, on power)
    pub lid_closed: bool,
}

impl Default for Awake {
    fn default() -> Self {
        Self {
            mode: KeepAwakeMode::UntilAgentsFinish,
            lid_closed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Updates {
    pub auto_check: bool,
}

impl Default for Updates {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub features: Features,
    pub appearance: Appearance,
    pub terminal: Terminal,
    /// Shortcut overrides: action id (shell/shortcuts.ts) to accelerator, empty string unbinds
    pub keys: BTreeMap<String, String>,
    pub agents: Agents,
    pub chats: Chats,
    pub usage: Usage,
    pub jira: Jira,
    pub notion: Notion,
    pub prs: Prs,
    pub awake: Awake,
    pub updates: Updates,
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// Defaults when the file is missing or unreadable
pub fn load(data_dir: &Path) -> Settings {
    std::fs::read(path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Merges `patch` (any subset of Settings) into the saved settings, validates and saves them atomically
pub fn update(data_dir: &Path, patch: &Value) -> Result<Settings, String> {
    let mut merged = serde_json::to_value(load(data_dir)).map_err(|e| e.to_string())?;
    merge(&mut merged, patch);
    let settings: Settings =
        serde_json::from_value(merged).map_err(|e| format!("invalid settings: {e}"))?;
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let tmp = data_dir.join("settings.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path(data_dir)).map_err(|e| e.to_string())?;
    Ok(settings)
}

/// Objects merge key by key; anything else replaces
fn merge(into: &mut Value, patch: &Value) {
    match (into, patch) {
        (Value::Object(into), Value::Object(patch)) => {
            for (key, value) in patch {
                merge(into.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (into, patch) => *into = patch.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patches_merge_and_old_files_keep_loading() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), r#"{"terminal":{"fontSize":14},"gone":1}"#).unwrap();
        let settings = update(dir.path(), &json!({"features": {"jira": true}})).unwrap();
        assert_eq!(settings.terminal.font_size, 14);
        assert!(settings.features.jira);
        assert!(settings.features.usage);
        assert_eq!(load(dir.path()), settings);
    }

    #[test]
    fn invalid_patches_change_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(update(dir.path(), &json!({"terminal": {"fontSize": "big"}})).is_err());
        assert!(!path(dir.path()).exists());
    }
}
