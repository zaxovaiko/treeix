//! Agent commands over treeix_core::agents: what agents spent, plan limits, ports their processes listen on,
//! and the flags, hooks and env every agent session starts with. Owner: A3

use super::Result;
use super::files::blocking;
use crate::daemon::Daemon;
use crate::types::{ProgressState, SessionEvent};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;
use treeix_core::agents::limits::{self, UsageLimits};
use treeix_core::agents::ports::{self, SessionPort};
use treeix_core::agents::transcripts::{self, AgentKind, SessionUsage};
use treeix_core::agents::usage::{self, AgentUsage};
use treeix_core::agents::{codex, hooks};
use treeix_proto::{Request, Response, SessionInfo, SessionKind};

/// Plan limits changed (statusline, rollout or a poll of Claude's usage endpoint)
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitsChanged {
    pub limits: UsageLimits,
}

// ponytail: polled, a file watcher on the sources if the title bar needs to follow faster
const LIMITS_POLL: Duration = Duration::from_secs(10);
/// After a codex session starts: Codex writes its rollout on the first prompt, which can come much later
const CODEX_LOOKS: [u64; 4] = [3, 10, 30, 90];
/// Rollouts started this long before the session still count: clocks and Codex's own start time differ
const CODEX_SLACK_MS: u64 = 5000;

fn status_dir() -> PathBuf {
    hooks::status_dir(&treeix_proto::data_dir())
}

fn home(app: &AppHandle) -> Result<PathBuf> {
    app.path().home_dir().map_err(|e| e.to_string())
}

fn agent_kind(kind: SessionKind) -> Option<AgentKind> {
    match kind {
        SessionKind::Claude => Some(AgentKind::Claude),
        SessionKind::Codex => Some(AgentKind::Codex),
        SessionKind::Shell | SessionKind::Routine => None,
    }
}

/// Before ptyd starts a claude or codex session: status hooks, skip-permission flags from settings, MCP env
pub(crate) fn prepare_agent(
    app: &AppHandle,
    create: &mut treeix_proto::CreateSession,
) -> Result<()> {
    let Some(kind) = agent_kind(create.kind) else {
        return Ok(());
    };
    create.env.extend(super::mcp::agent_env(app));
    // Only the agent itself takes the flags, not a shell or script started as one
    let program = create
        .command
        .first()
        .map(|p| p.rsplit('/').next().unwrap_or(p));
    let expected = match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
    };
    if program != Some(expected) {
        return Ok(());
    }
    let settings = treeix_core::settings::load(&treeix_proto::data_dir()).agents;
    let mut flags = Vec::new();
    match kind {
        AgentKind::Claude => {
            let (json, env) = hooks::claude_settings(&status_dir(), &home(app)?.join(".claude"))?;
            flags.extend(["--settings".to_owned(), json]);
            create.env.extend(env);
            if settings.skip_permissions_claude {
                flags.push("--dangerously-skip-permissions".into());
            }
        }
        // Codex has no hooks: ptyd reads its status off the screen
        AgentKind::Codex if settings.skip_permissions_codex => {
            flags.push("--dangerously-bypass-approvals-and-sandbox".into());
        }
        AgentKind::Codex => {}
    }
    create.command.splice(1..1, flags);
    Ok(())
}

/// Codex keeps no id ptyd could read, so after a codex session starts its rollout is looked for a few times:
/// the oldest conversation in its folder since it started that no other session has
pub(crate) fn find_codex_conversation(app: &AppHandle, info: &SessionInfo) {
    if info.kind != SessionKind::Codex || info.agent_session.is_some() {
        return;
    }
    let (app, session, cwd) = (app.clone(), info.id.clone(), info.cwd.clone());
    let since = info.created_at.saturating_sub(CODEX_SLACK_MS);
    tauri::async_runtime::spawn(async move {
        let mut waited = 0;
        for at in CODEX_LOOKS {
            tokio::time::sleep(Duration::from_secs(at - waited)).await;
            waited = at;
            match codex_conversation(&app, &session, &cwd, since).await {
                Ok(Some(found)) => {
                    let daemon = app.state::<Arc<Daemon>>();
                    let req = Request::SetAgentSession {
                        session,
                        agent_session: found,
                    };
                    if let Err(e) = daemon.request(req).await {
                        tracing::warn!("codex conversation: {e}");
                    }
                    return;
                }
                Ok(None) => {}
                // The session is gone
                Err(_) => return,
            }
        }
    });
}

async fn codex_conversation(
    app: &AppHandle,
    session: &str,
    cwd: &str,
    since: u64,
) -> Result<Option<String>> {
    let sessions = list(&app.state::<Arc<Daemon>>()).await?;
    let me = sessions
        .iter()
        .find(|s| s.id == session)
        .ok_or("session closed")?;
    if me.agent_session.is_some() {
        return Err("already known".into());
    }
    let taken: Vec<String> = sessions
        .into_iter()
        .filter_map(|s| s.agent_session)
        .collect();
    let (home, cwd) = (home(app)?, cwd.to_owned());
    blocking(move || {
        Ok(codex::codex_conversations(&home, &cwd, since)
            .into_iter()
            .map(|c| c.id)
            .find(|id| !taken.contains(id)))
    })
    .await
}

async fn list(daemon: &Daemon) -> Result<Vec<SessionInfo>> {
    match daemon.request(Request::List).await? {
        Response::Sessions(list) => Ok(list),
        other => Err(super::unexpected(other)),
    }
}

/// Messages, cost and first prompt of a closed agent session, for its History record
pub(super) fn record_stats(
    home: &Path,
    info: &crate::types::SessionInfo,
) -> (Option<u32>, Option<f64>, Option<String>) {
    let kind = match info.kind {
        crate::types::SessionKind::Claude => AgentKind::Claude,
        crate::types::SessionKind::Codex => AgentKind::Codex,
        _ => return (None, None, None),
    };
    let cost = hooks::claude_cost(&status_dir(), &info.id);
    let transcript = info
        .agent_session
        .as_deref()
        .and_then(|id| transcripts::transcript_path(home, kind, id))
        .and_then(|path| std::fs::read_to_string(path).ok());
    let Some(transcript) = transcript else {
        return (None, cost, None);
    };
    let stats = transcripts::transcript_stats(kind, &transcript);
    (Some(stats.messages), cost, stats.first_prompt)
}

/// Each session's OSC 9;4 progress, combined on the dock icon
static PROGRESS: Mutex<Option<HashMap<String, (ProgressState, u8)>>> = Mutex::new(None);

/// Keeps the dock's progress bar on what the sessions report: an error first, then the average of the ones
/// with a percent, then busy
pub(crate) fn on_session_event(app: &AppHandle, event: &SessionEvent) {
    let mut progress = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    let progress = progress.get_or_insert_with(HashMap::new);
    match event {
        SessionEvent::Progress {
            session,
            state: ProgressState::Off,
            ..
        }
        | SessionEvent::Removed { session }
        | SessionEvent::Exit { session, .. } => {
            if progress.remove(session).is_none() {
                return;
            }
        }
        SessionEvent::Progress {
            session,
            state,
            percent,
        } => {
            progress.insert(session.clone(), (*state, *percent));
        }
        _ => return,
    }
    let state = dock_progress(progress.values().copied());
    if let Some(window) = app.get_webview_window("main")
        && let Err(e) = window.set_progress_bar(state)
    {
        tracing::warn!("dock progress: {e}");
    }
}

fn dock_progress(sessions: impl Iterator<Item = (ProgressState, u8)>) -> ProgressBarState {
    let sessions: Vec<_> = sessions.collect();
    let has = |state| sessions.iter().any(|&(s, _)| s == state);
    let measured: Vec<u64> = sessions
        .iter()
        .filter(|(s, _)| {
            matches!(
                s,
                ProgressState::Normal | ProgressState::Paused | ProgressState::Error
            )
        })
        .map(|&(_, p)| u64::from(p))
        .collect();
    let status = if sessions.is_empty() {
        ProgressBarStatus::None
    } else if has(ProgressState::Error) {
        ProgressBarStatus::Error
    } else if has(ProgressState::Normal) {
        ProgressBarStatus::Normal
    } else if has(ProgressState::Paused) {
        ProgressBarStatus::Paused
    } else {
        ProgressBarStatus::Indeterminate
    };
    ProgressBarState {
        status: Some(status),
        progress: (!measured.is_empty())
            .then(|| measured.iter().sum::<u64>() / measured.len() as u64),
    }
}

/// Token usage by day, agent, model and project across every transcript
#[tauri::command]
#[specta::specta]
pub async fn agent_usage(app: AppHandle) -> Result<AgentUsage> {
    let (home, cache) = (home(&app)?, treeix_proto::data_dir());
    usage::refresh_prices(&cache).await;
    blocking(move || usage::agent_usage(&home, &cache)).await
}

static LIMITS_WATCHED: AtomicBool = AtomicBool::new(false);

/// Both agents' 5-hour and weekly windows; `UsageLimitsChanged` follows any change
#[tauri::command]
#[specta::specta]
pub async fn usage_limits(app: AppHandle) -> Result<UsageLimits> {
    let home = home(&app)?;
    let limits = read_limits(home.clone()).await?;
    if !LIMITS_WATCHED.swap(true, Ordering::AcqRel) {
        watch_limits(app, home, limits);
    }
    Ok(limits)
}

async fn read_limits(home: PathBuf) -> Result<UsageLimits> {
    blocking(move || {
        Ok(limits::usage_limits(
            &home,
            &status_dir().join(hooks::LATEST),
        ))
    })
    .await
}

/// Started by the first `usage_limits`; idle while the usage feature is off
fn watch_limits(app: AppHandle, home: PathBuf, mut last: UsageLimits) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(LIMITS_POLL).await;
            if !treeix_core::settings::load(&treeix_proto::data_dir())
                .features
                .usage
            {
                continue;
            }
            let Ok(limits) = read_limits(home.clone()).await else {
                continue;
            };
            if limits != last {
                last = limits;
                if let Err(e) = (UsageLimitsChanged { limits }).emit(&app) {
                    tracing::warn!("emit usage limits: {e}");
                }
            }
        }
    });
}

/// What a claude or codex session's conversation spent; None before it has one
#[tauri::command]
#[specta::specta]
pub async fn session_usage(
    app: AppHandle,
    daemon: State<'_, Arc<Daemon>>,
    session: String,
) -> Result<Option<SessionUsage>> {
    let info = list(&daemon)
        .await?
        .into_iter()
        .find(|s| s.id == session)
        .ok_or_else(|| format!("no session {session}"))?;
    let (Some(kind), Some(agent_session)) = (agent_kind(info.kind), info.agent_session) else {
        return Ok(None);
    };
    let home = home(&app)?;
    blocking(move || {
        let usage = transcripts::transcript_usage(&home, kind, &agent_session)?;
        Ok(usage.map(|usage| SessionUsage {
            cost_usd: hooks::claude_cost(&status_dir(), &info.id),
            ..usage
        }))
    })
    .await
}

async fn live_ports(daemon: &Daemon) -> Result<Vec<SessionPort>> {
    let shells: HashMap<String, u32> = list(daemon)
        .await?
        .into_iter()
        .filter_map(|s| Some((s.id, s.pid?)))
        .collect();
    blocking(move || ports::session_ports(&shells)).await
}

/// TCP ports listened on by processes under any live session
#[tauri::command]
#[specta::specta]
pub async fn session_ports(daemon: State<'_, Arc<Daemon>>) -> Result<Vec<SessionPort>> {
    live_ports(&daemon).await
}

/// SIGTERM to the process listening on `port`; refuses one that is not under a Treeix session
#[tauri::command]
#[specta::specta]
pub async fn kill_port(daemon: State<'_, Arc<Daemon>>, port: u16, pid: u32) -> Result<()> {
    let listening = live_ports(&daemon)
        .await?
        .iter()
        .any(|p| p.port == port && p.pid == pid);
    if !listening {
        return Err(format!(
            "no Treeix session process {pid} listens on port {port}"
        ));
    }
    let pid = libc::pid_t::try_from(pid).map_err(|e| e.to_string())?;
    // SAFETY: kill only sends a signal to the pid checked above
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_progress_shows_errors_first_then_the_average_percent() {
        let progress = |sessions: &[(ProgressState, u8)]| dock_progress(sessions.iter().copied());
        let none = progress(&[]);
        assert!(matches!(none.status, Some(ProgressBarStatus::None)));
        let normal = progress(&[
            (ProgressState::Normal, 20),
            (ProgressState::Normal, 60),
            (ProgressState::Indeterminate, 0),
        ]);
        assert!(matches!(normal.status, Some(ProgressBarStatus::Normal)));
        assert_eq!(normal.progress, Some(40));
        let error = progress(&[(ProgressState::Normal, 20), (ProgressState::Error, 100)]);
        assert!(matches!(error.status, Some(ProgressBarStatus::Error)));
        let busy = progress(&[(ProgressState::Indeterminate, 0)]);
        assert!(matches!(
            busy.status,
            Some(ProgressBarStatus::Indeterminate)
        ));
        assert_eq!(busy.progress, None);
    }
}
