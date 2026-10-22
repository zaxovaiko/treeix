//! Routines: agent runs ptyd starts on a schedule, a gh/acli event or a webhook, also while the app is closed.
//! These are also the webview's types (`specta` feature). `Trigger` is tagged, so frames carry `Routine`s as JSON
//! (`chat::as_json`); `RoutineRun` has only plain enums and goes through postcard as is.

use crate::SessionId;
use crate::chat::ChatAgent;
use serde::{Deserialize, Serialize};

pub type RoutineId = String;
pub type RunId = String;

/// Webhook routines listen on `http://127.0.0.1:<WEBHOOK_PORT>/r/<token>`
pub const WEBHOOK_PORT: u16 = 47311;

/// What starts a routine
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trigger {
    /// 5-field cron in local time, like `0 9 * * 1-5`; `treeix_core::routines::next_fire` reads it
    Schedule { cron: String },
    /// A gh / acli event, polled every 60 s with ETags
    Event { event: RoutineEvent },
    /// A POST to the webhook URL with this token; the body is the prompt's `{body}`. ptyd makes the token
    Webhook { token: String },
}

/// Prompt variables per event: review `{pr} {title} {author}`, ci `{pr} {branch} {job}`,
/// comment `{pr} {author} {comment}`, ticket `{ticket} {title} {desc}`
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutineEvent {
    ReviewRequested,
    CiFailed,
    PrComment,
    TicketAssigned,
}

/// Where a run happens
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutinePlace {
    /// The repo's main checkout
    Root,
    /// A fresh worktree per run, on a `routine/<name>-<date>` branch
    NewWorktree,
    /// The worktree of the PR the event is about, added when missing (PR events only)
    PrWorktree,
}

/// Claude `--permission-mode` (plan / acceptEdits / bypassPermissions) and Codex `--sandbox`
/// (read-only / workspace-write / danger-full-access)
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutinePermission {
    ReadOnly,
    EditFiles,
    Anything,
}

/// What happens to a schedule that came due while the computer slept
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhileAsleep {
    /// One run on wake, however many were missed
    CatchUp,
    /// Recorded as a skipped run
    Skip,
}

/// A run over either limit is killed and ends `OverBudget`
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// `--max-turns`
    pub max_turns: Option<u32>,
    /// USD, from the transcript's token usage
    pub max_cost: Option<f64>,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    /// Empty in `RoutinePut` creates one
    pub id: RoutineId,
    pub name: String,
    pub enabled: bool,
    pub agent: ChatAgent,
    /// With the trigger's `{variables}`
    pub prompt: String,
    pub trigger: Trigger,
    /// Repo the run happens in; None only for events, meaning whichever repo the event comes from
    pub repo: Option<String>,
    pub place: RoutinePlace,
    pub permission: RoutinePermission,
    /// Extra `--allowedTools` patterns, like `Bash(npm test:*)`
    pub allowed_tools: Vec<String>,
    pub budget: Budget,
    /// May push, open PRs and post comments; off, the prompt says not to and `gh` writes are denied
    pub may_push: bool,
    pub asleep: WhileAsleep,
    /// Unix ms; ptyd sets it
    pub created_at: u64,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunCause {
    Schedule,
    /// The one run for schedules missed while asleep
    CatchUp,
    Event,
    Webhook,
    /// Run now
    Manual,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// Waiting for a slot (settings.routines.maxParallel)
    Queued,
    Running,
    Ok,
    Failed,
    /// Killed at `Budget`
    OverBudget,
    /// Came due while asleep with `WhileAsleep::Skip`, or the routine was off
    Skipped,
    Cancelled,
}

/// One firing of a routine; kept in `<data dir>/routines/runs.jsonl`, finished ones also in History
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: RunId,
    pub routine: RoutineId,
    /// The routine's name when it fired, for runs of removed routines
    pub name: String,
    pub cause: RunCause,
    pub status: RunStatus,
    /// What fired it, like `#412 Fix login (octocat)`, `ABC-12`, the webhook body's first line
    pub detail: Option<String>,
    /// When it was due (schedule) or fired; unix ms
    pub due_at: u64,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    /// The `SessionKind::Routine` session it runs in
    pub session: Option<SessionId>,
    pub cwd: Option<String>,
    pub turns: u32,
    /// USD so far
    pub cost: f64,
    /// Why it failed, was skipped or stopped, like `Stopped at the $5.00 budget`
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triggers_are_tagged_json() {
        let trigger = Trigger::Event {
            event: RoutineEvent::CiFailed,
        };
        assert_eq!(
            serde_json::to_string(&trigger).unwrap(),
            r#"{"kind":"event","event":"ciFailed"}"#
        );
    }
}
