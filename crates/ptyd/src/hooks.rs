//! Agent status from Claude's hooks: each session's agent writes `input|working|done` to
//! `$TREEIX_AGENT_STATUS/<TREEIX_SESSION>` and its statusline JSON to `usage-<TREEIX_SESSION>`.
//! The watcher maps them onto SessionStatus (Watching when the screen footer shows background work) and
//! broadcasts Event::AgentSession when the conversation id changes. Codex, and Claude started in a shell, have no
//! hooks and are read off the screen. Port of the Electron terminal plugin's hooks.ts and agentStatus.ts
//!
//! "Done until shown" is the app's: ptyd reports Done, the app shows a done session on screen as idle.

use crate::server::Daemon;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use treeix_proto::{Event, SessionId, SessionKind, SessionStatus};

pub const STATUS_ENV: &str = "TREEIX_AGENT_STATUS";
const USAGE_PREFIX: &str = "usage-";
// ponytail: polls the folder; a file watcher if many sessions make the reads show up
const POLL: Duration = Duration::from_millis(400);
const FOOTER_ROWS: usize = 3;

pub fn status_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-status")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hook {
    Input,
    Working,
    Done,
}

impl Hook {
    fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "input" => Some(Self::Input),
            "working" => Some(Self::Working),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

/// What an agent is doing right now; Watching is a turn that ended with a shell, monitor or subagent left running
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentState {
    Input,
    Running,
    Watching,
    Idle,
}

/// Claude from its hooks, which report every change, so before the first one it sits at its prompt; other
/// agents are read off the screen. Never from output timing: a TUI redraws while it waits
fn agent_state(hooked: Option<Hook>, has_hooks: bool, screen: &str) -> AgentState {
    match hooked {
        Some(Hook::Input) => AgentState::Input,
        Some(Hook::Working) => AgentState::Running,
        _ if hooked.is_some() || has_hooks => {
            if background_work(screen) {
                AgentState::Watching
            } else {
                AgentState::Idle
            }
        }
        _ if waiting_for_input(screen) => AgentState::Input,
        _ if screen.to_lowercase().contains("esc to interrupt") => AgentState::Running,
        _ => AgentState::Idle,
    }
}

/// A finished turn is Done (the app shows it as idle once on screen); a session that never worked is Idle
fn agent_status(previous: SessionStatus, state: AgentState, finished: bool) -> SessionStatus {
    match state {
        AgentState::Input => SessionStatus::Needs,
        AgentState::Running => SessionStatus::Running,
        AgentState::Watching => SessionStatus::Watching,
        AgentState::Idle if finished || previous == SessionStatus::Done => SessionStatus::Done,
        AgentState::Idle => SessionStatus::Idle,
    }
}

// ponytail: screen-scraped prompt detection for agents without hooks
fn waiting_for_input(screen: &str) -> bool {
    let screen = screen.to_lowercase();
    let first_option = screen.match_indices('❯').any(|(at, mark)| {
        screen[at + mark.len()..]
            .trim_start()
            .strip_prefix("1.")
            .is_some_and(|rest| rest.trim_start().starts_with("yes"))
    });
    first_option
        || [
            "do you want to",
            "yes, and don't ask",
            "[y/n]",
            "(y/n)",
            "allow command",
            "would you like to run",
            "press enter to continue",
        ]
        .iter()
        .any(|prompt| screen.contains(prompt))
}

// ponytail: screen-scraped, Claude's footer counts what it left running after its turn, e.g. "· 1 shell"; no
// hook reports it
fn background_work(screen: &str) -> bool {
    let lines: Vec<&str> = screen.trim_end().lines().collect();
    lines[lines.len().saturating_sub(FOOTER_ROWS)..]
        .iter()
        .any(|line| counts_background_work(&line.trim_end().to_lowercase()))
}

/// `· <n> <shell|monitor|agent|background task>[s]` at the end of the line
fn counts_background_work(line: &str) -> bool {
    let singular = line.strip_suffix('s').into_iter().chain([line]);
    singular.into_iter().any(|line| {
        ["shell", "monitor", "agent", "background task"]
            .iter()
            .filter_map(|what| line.strip_suffix(what))
            .any(|before| {
                let count = before.trim_end();
                let label = count.trim_end_matches(|c: char| c.is_ascii_digit());
                let dot = label.trim_end();
                count.len() < before.len()
                    && label.len() < count.len()
                    && dot.len() < label.len()
                    && dot.ends_with('·')
            })
    })
}

/// The conversation Claude writes to now: `/clear`, a resume or a plan's fresh start each begin a new one in the
/// same terminal
fn status_line_conversation(text: &str) -> Option<String> {
    let input: serde_json::Value = serde_json::from_str(text).ok()?;
    let id = input.get("session_id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_owned())
}

/// What the watcher last saw of a session, so an unchanged one costs two small reads
#[derive(Default)]
struct Seen {
    hook: Option<Hook>,
    seq: u64,
    usage_modified: Option<SystemTime>,
    /// Codex was seen working since its last finished turn
    worked: bool,
}

/// Starts watching `status_dir`; must run inside the tokio runtime
pub fn watch(daemon: &Arc<Daemon>) {
    let dir = status_dir(&daemon.data_dir);
    let _ = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir);
    let daemon = daemon.clone();
    tokio::spawn(async move {
        let mut seen: HashMap<SessionId, Seen> = HashMap::new();
        let mut every = tokio::time::interval(POLL);
        loop {
            every.tick().await;
            if daemon.stopping() {
                return;
            }
            let sessions = daemon.sessions();
            seen.retain(|id, _| sessions.iter().any(|s| &s.id == id));
            for session in sessions {
                let kind = session.info().kind;
                if matches!(kind, SessionKind::Claude | SessionKind::Codex) && session.is_live() {
                    let seen = seen.entry(session.id.clone()).or_default();
                    poll(&daemon, &session, kind, &dir, seen);
                } else {
                    // A shell back at its prompt starts fresh with its next agent
                    seen.remove(&session.id);
                }
            }
        }
    });
}

/// Only a launched Claude has the hooks (`--settings`); one started in a shell is read off its screen like Codex
fn poll(
    daemon: &Daemon,
    session: &crate::session::Session,
    kind: SessionKind,
    dir: &Path,
    seen: &mut Seen,
) {
    let hooked = session.launched == SessionKind::Claude;
    if hooked {
        let usage = dir.join(format!("{USAGE_PREFIX}{}", session.id));
        let modified = fs::metadata(&usage).and_then(|m| m.modified()).ok();
        if modified != seen.usage_modified {
            seen.usage_modified = modified;
            let conversation = fs::read_to_string(&usage)
                .ok()
                .and_then(|t| status_line_conversation(&t));
            if let Some(agent_session) = conversation.filter(|c| session.set_agent_session(c)) {
                daemon.broadcast(Event::AgentSession {
                    session: session.id.clone(),
                    agent_session,
                });
                daemon.mark_state_dirty();
            }
        }
    }
    let hook = hooked
        .then(|| fs::read_to_string(dir.join(&session.id)).ok())
        .flatten()
        .and_then(|t| Hook::parse(&t));
    let seq = session.info().seq;
    // The screen only matters while no hook says input or working
    let screen_matters = !matches!(hook, Some(Hook::Input | Hook::Working));
    if hook == seen.hook && (seq == seen.seq || !screen_matters) {
        return;
    }
    seen.hook = hook;
    seen.seq = seq;
    let screen = if screen_matters {
        session.screen_text()
    } else {
        String::new()
    };
    let state = agent_state(hook, hooked, &screen);
    let finished = if hooked {
        hook == Some(Hook::Done)
    } else {
        std::mem::replace(&mut seen.worked, state == AgentState::Running)
            && state == AgentState::Idle
    };
    if !hooked && state == AgentState::Input {
        seen.worked = true;
    }
    let status = agent_status(session.info().status, state, finished);
    session.set_live_status(daemon, status, kind);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(hooked: Option<Hook>, has_hooks: bool, screen: &str) -> AgentState {
        agent_state(hooked, has_hooks, screen)
    }

    #[test]
    fn hooks_decide_for_claude_even_before_the_first_one_fires() {
        assert_eq!(state(Some(Hook::Working), true, ""), AgentState::Running);
        assert_eq!(state(Some(Hook::Input), true, ""), AgentState::Input);
        assert_eq!(
            state(Some(Hook::Done), true, "esc to interrupt"),
            AgentState::Idle
        );
        assert_eq!(
            state(None, true, "Do you want to proceed?"),
            AgentState::Idle
        );
    }

    #[test]
    fn claude_watching_a_background_shell_after_its_turn_is_watching_not_working() {
        let screen = |footer: &str| {
            format!(
                "✻ Crunched for 3s · done 18:12 · 1 shell still running\n\n❯ \n\n  Opus 5.5 | 2.0%\n  ⏵⏵ bypass permissions on{footer}\n\n"
            )
        };
        assert_eq!(
            state(Some(Hook::Done), true, &screen(" · 1 shell")),
            AgentState::Watching
        );
        assert_eq!(
            state(None, true, &screen(" · 2 shells")),
            AgentState::Watching
        );
        assert_eq!(state(Some(Hook::Done), true, &screen("")), AgentState::Idle);
        assert_eq!(
            state(None, true, &screen(" · 3 background tasks")),
            AgentState::Watching
        );
        assert_eq!(state(None, true, &screen(" ·1 shell")), AgentState::Idle);
    }

    #[test]
    fn agents_without_hooks_are_read_off_the_screen() {
        assert_eq!(
            state(None, false, "• Working (3s • esc to interrupt)"),
            AgentState::Running
        );
        assert_eq!(
            state(None, false, "Would you like to run the following command?"),
            AgentState::Input
        );
        assert_eq!(
            state(None, false, "  ❯ 1. Yes\n    2. No"),
            AgentState::Input
        );
        assert_eq!(state(None, false, "› "), AgentState::Idle);
    }

    #[test]
    fn a_finished_turn_is_done_until_the_app_shows_it() {
        use SessionStatus::*;
        assert_eq!(agent_status(Running, AgentState::Idle, true), Done);
        assert_eq!(agent_status(Idle, AgentState::Idle, true), Done);
        assert_eq!(agent_status(Done, AgentState::Idle, false), Done);
        assert_eq!(agent_status(Running, AgentState::Idle, false), Idle);
        assert_eq!(agent_status(Idle, AgentState::Idle, false), Idle);
        assert_eq!(agent_status(Done, AgentState::Running, false), Running);
    }

    #[test]
    fn status_line_conversation_reads_the_session_id() {
        assert_eq!(
            status_line_conversation(r#"{"session_id":"abc"}"#),
            Some("abc".into())
        );
        assert_eq!(status_line_conversation(r#"{"session_id":""}"#), None);
        assert_eq!(status_line_conversation("not json"), None);
    }
}
