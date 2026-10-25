//! System integration: command line tools, updates (updater.rs), keep awake (keep_awake.rs) and the tray (tray.rs).
//! Owner: U6

use super::Result;
use crate::daemon::Daemon;
use crate::{keep_awake, tray, updater};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager};
use tauri_specta::Event;
use treeix_core::settings;
use treeix_proto::{Request, Response, SessionKind, SessionStatus};

/// Each CLI call gives up after this; a tool that hangs shows as unknown, not as a frozen page
const CLI_TIMEOUT: Duration = Duration::from_secs(3);

/// claude, codex, acli, gh, glab
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliTool {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    /// None when the tool has no sign-in or it could not tell
    pub signed_in: Option<bool>,
    pub account: Option<String>,
    /// A newer version, when the tool says so
    pub update: Option<String>,
    /// `update_cli_tool` knows how to update it: it updates itself, or Homebrew installed it
    pub updatable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// Markdown release notes
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeState {
    /// The toggle is on
    pub on: bool,
    /// The assertion is held now (with `untilAgentsFinish`, only while an agent runs)
    pub active: bool,
}

/// In setup: the tray, keep awake from the saved settings, both kept current by session, settings and limits events;
/// the update check on start
pub(crate) fn setup(app: &AppHandle) {
    app.manage(keep_awake::KeepAwake::default());
    app.manage(tray::Tray::default());
    app.manage(updater::Found::default());
    let saved = settings::load(&treeix_proto::data_dir());
    keep_awake::get(app).apply(app, &saved, None);
    tray::get(app).render(app, &saved);

    let handle = app.clone();
    super::SettingsChanged::listen_any(app, move |event| {
        let saved = &event.payload.settings;
        keep_awake::get(&handle).apply(&handle, saved, None);
        tray::get(&handle).render(&handle, saved);
    });
    let handle = app.clone();
    super::UsageLimitsChanged::listen_any(app, move |event| {
        tray::get(&handle).set_limits(&handle, event.payload.limits);
    });
    let handle = app.clone();
    app.listen_any("session-event", move |event| {
        // Output never comes this way, so every event is worth a fresh list
        if !event.payload().contains(r#""type":"bell""#) {
            tauri::async_runtime::spawn(watch_sessions(handle.clone()));
        }
    });
    if saved.updates.auto_check {
        tauri::async_runtime::spawn(updater::check_and_ask(app.clone(), true));
    }
}

/// Agents running drive keep awake; sessions that need you go to the tray
async fn watch_sessions(app: AppHandle) {
    let Some(daemon) = app.try_state::<Arc<Daemon>>() else {
        return;
    };
    let Ok(Response::Sessions(list)) = daemon.request(Request::List).await else {
        return;
    };
    let agent = |kind| matches!(kind, SessionKind::Claude | SessionKind::Codex);
    let running = list.iter().any(|s| {
        agent(s.kind) && matches!(s.status, SessionStatus::Running | SessionStatus::Watching)
    });
    let needs = list
        .iter()
        .filter(|s| s.status == SessionStatus::Needs)
        .map(|s| s.title.clone())
        .collect();
    let saved = settings::load(&treeix_proto::data_dir());
    let handle = app.clone();
    // keep awake may run the pmset prompt
    let _ = tauri::async_runtime::spawn_blocking(move || {
        keep_awake::get(&handle).apply(&handle, &saved, Some(running));
        tray::get(&handle).set_needs(&handle, needs);
    })
    .await;
}

/// On quit
pub(crate) fn exit(app: &AppHandle) {
    if let Some(awake) = app.try_state::<keep_awake::KeepAwake>() {
        awake.restore();
    }
}

#[tauri::command]
#[specta::specta]
pub async fn cli_tools() -> Result<Vec<CliTool>> {
    Ok(futures_join(TOOLS.map(cli_tool)).await)
}

const TOOLS: [&str; 5] = ["claude", "codex", "acli", "gh", "glab"];

/// Updates a tool the way it was installed, then checks it again
#[tauri::command]
#[specta::specta]
pub async fn update_cli_tool(name: String) -> Result<CliTool> {
    let name = TOOLS
        .into_iter()
        .find(|tool| *tool == name)
        .ok_or_else(|| format!("{name}: not a known tool"))?;
    let command = update_command(name).await.ok_or_else(|| {
        format!("{name} was not installed with Homebrew; update it the way you installed it")
    })?;
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    run_command(home, command).await?;
    Ok(cli_tool(name).await)
}

/// claude and codex update themselves, through their package manager when one installed them; the rest only when
/// the binary lives in Homebrew's Cellar, under the formula it names
async fn update_command(name: &str) -> Option<String> {
    if matches!(name, "claude" | "codex") {
        return Some(format!("{name} update"));
    }
    let (ok, out) = in_login_shell(&format!("command -v {name}")).await?;
    let path = std::fs::canonicalize(out.lines().next()?.trim())
        .ok()
        .filter(|_| ok)?;
    brew_formula(&path).map(|formula| format!("brew upgrade {formula}"))
}

/// "acli" in /opt/homebrew/Cellar/acli/1.3.36-stable/bin/acli
fn brew_formula(path: &std::path::Path) -> Option<String> {
    let mut parts = path.iter();
    parts.find(|part| *part == "Cellar")?;
    parts
        .next()
        .map(|formula| formula.to_string_lossy().into_owned())
}

async fn futures_join<F: std::future::Future<Output = CliTool> + Send + 'static>(
    tools: [F; 5],
) -> Vec<CliTool> {
    let handles = tools.map(tauri::async_runtime::spawn);
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(tool) = handle.await {
            out.push(tool);
        }
    }
    out
}

async fn cli_tool(name: &'static str) -> CliTool {
    let version_command = format!("{name} --version");
    let (version, update_command) =
        tokio::join!(in_login_shell(&version_command), update_command(name));
    let mut tool = CliTool {
        name: name.into(),
        installed: version.as_ref().is_some_and(|(ok, _)| *ok),
        version: version.and_then(|(ok, out)| ok.then(|| version_of(&out)).flatten()),
        signed_in: None,
        account: None,
        update: None,
        updatable: false,
    };
    if !tool.installed {
        return tool;
    }
    let (signed_in, account) = match name {
        "gh" | "glab" => in_login_shell(&format!("{name} auth status"))
            .await
            .map(|(_, out)| {
                let account = treeix_core::prs::signed_in_accounts(&out)
                    .into_iter()
                    .next();
                (Some(account.is_some()), account)
            })
            .unwrap_or((None, None)),
        "codex" => in_login_shell("codex login status")
            .await
            .map(|(ok, _)| (Some(ok), None))
            .unwrap_or((None, None)),
        "acli" => in_login_shell("acli jira auth status")
            .await
            .map(|(ok, out)| (Some(ok), ok.then(|| acli_account(&out)).flatten()))
            .unwrap_or((None, None)),
        "claude" => claude_account(),
        _ => (None, None),
    };
    tool.signed_in = signed_in;
    tool.account = account;
    tool.updatable = update_command.is_some();
    tool
}

/// Long enough for a push behind a pre-push hook
const RUN_TIMEOUT: Duration = Duration::from_secs(600);

/// A one-off command (git pull, commit, push) in the login shell at `cwd` with no terminal, so git neither prompts
/// nor opens an editor. Its output, or the output as the error
#[tauri::command]
#[specta::specta]
pub async fn run_command(cwd: String, command: String) -> Result<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = tokio::process::Command::new(shell)
        .args(["-lc", &command])
        .current_dir(&cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(RUN_TIMEOUT, child)
        .await
        .map_err(|_| format!("{command}: still running after 10 minutes, stopped"))?
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    match (out.status.success(), text.is_empty()) {
        (true, _) => Ok(text),
        (false, true) => Err(format!("{command}: {}", out.status)),
        (false, false) => Err(text),
    }
}

/// Success and stdout + stderr, from the user's login shell so PATH matches the terminal sessions; None on timeout
async fn in_login_shell(command: &str) -> Option<(bool, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = tokio::process::Command::new(shell)
        .args(["-lc", command])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(CLI_TIMEOUT, child).await.ok()?.ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Some((out.status.success(), text))
}

/// The first x.y.z in a `--version` line: "2.1.4 (Claude Code)", "gh version 2.82.0 (...)", "codex-cli 0.48.0"
fn version_of(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let word = word.trim_start_matches('v');
        let parts: Vec<&str> = word.split('.').collect();
        (parts.len() >= 3
            && parts[..3]
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .then(|| parts[..3].join("."))
    })
}

/// "Email: me@example.com" in `acli jira auth status`
fn acli_account(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim().eq_ignore_ascii_case("email")).then(|| value.trim().to_string())
    })
}

/// Claude Code keeps the signed-in account in ~/.claude.json
fn claude_account() -> (Option<bool>, Option<String>) {
    let Some(home) = std::env::var_os("HOME") else {
        return (None, None);
    };
    let Ok(bytes) = std::fs::read(std::path::Path::new(&home).join(".claude.json")) else {
        return (None, None);
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return (None, None);
    };
    let email = json
        .pointer("/oauthAccount/emailAddress")
        .and_then(|v| v.as_str())
        .map(String::from);
    (
        Some(email.is_some() || json.get("primaryApiKey").is_some()),
        email,
    )
}

/// None when this is the newest version
#[tauri::command]
#[specta::specta]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>> {
    updater::check(&app).await
}

/// Downloads and installs the update `check_update` found, then restarts
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<()> {
    updater::install(&app).await
}

#[tauri::command]
#[specta::specta]
pub async fn keep_awake(app: AppHandle) -> Result<KeepAwakeState> {
    let saved = settings::load(&treeix_proto::data_dir());
    Ok(keep_awake::get(&app).state(&saved))
}

/// Turns the toggle on or off, in settings.awake.mode; `KeepAwakeState` follows each change
#[tauri::command]
#[specta::specta]
pub async fn set_keep_awake(app: AppHandle, on: bool) -> Result<KeepAwakeState> {
    let current = settings::load(&treeix_proto::data_dir()).awake.mode;
    let mode = match (on, current) {
        (false, _) => settings::KeepAwakeMode::Off,
        (true, settings::KeepAwakeMode::Off) => settings::KeepAwakeMode::UntilAgentsFinish,
        (true, mode) => mode,
    };
    // Through update_settings, so every window and the listener in `setup` see it
    super::update_settings(
        app.clone(),
        serde_json::json!({ "awake": { "mode": mode } }),
    )
    .await?;
    keep_awake(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_come_from_any_version_line() {
        assert_eq!(version_of("2.1.4 (Claude Code)").as_deref(), Some("2.1.4"));
        assert_eq!(
            version_of("gh version 2.82.0 (2026-09-03)\nhttps://x").as_deref(),
            Some("2.82.0")
        );
        assert_eq!(version_of("codex-cli 0.48.0").as_deref(), Some("0.48.0"));
        assert_eq!(version_of("acli v1.3.2-stable").as_deref(), None);
        assert_eq!(
            version_of("glab 1.48.0 (44790937b)").as_deref(),
            Some("1.48.0")
        );
        assert_eq!(version_of("command not found"), None);
    }

    #[test]
    fn homebrew_formulas_come_from_the_cellar_path() {
        assert_eq!(
            brew_formula("/opt/homebrew/Cellar/acli/1.3.36-stable/bin/acli".as_ref()).as_deref(),
            Some("acli")
        );
        assert_eq!(
            brew_formula("/usr/local/Cellar/gh/2.102.0/bin/gh".as_ref()).as_deref(),
            Some("gh")
        );
        assert_eq!(brew_formula("/usr/bin/gh".as_ref()), None);
    }

    #[test]
    fn the_acli_account_is_its_email_line() {
        assert_eq!(
            acli_account("✓ Authenticated\n  Site: x.atlassian.net\n  Email: me@x.dev\n")
                .as_deref(),
            Some("me@x.dev")
        );
        assert_eq!(acli_account("not logged in"), None);
    }
}
