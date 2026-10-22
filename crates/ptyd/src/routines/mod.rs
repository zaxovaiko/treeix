//! The routines engine: ptyd fires agent runs on a schedule, a gh/acli event or a webhook, also while the app is
//! closed. Routines live in `<data dir>/routines/routines.json`, runs in `routines/runs.jsonl`; a run is a
//! `SessionKind::Routine` session, and its History record (`SessionRecord.run`) is written when it ends.
//! Contract: docs/next/phase67-contract.md. Owner: R6

pub mod budget;
pub mod schedule;
pub mod triggers;

use crate::server::{Daemon, Outbox};
use schedule::{Clock, Due};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;
use treeix_core::agents::transcripts::{self, AgentKind};
use treeix_core::agents::{codex, usage};
use treeix_core::git::{self, NewWorktree};
use treeix_core::history::{self, RecordKind, SessionRecord};
use treeix_core::prs::{self, PrState};
use treeix_core::routines::{
    Routine, RoutinePermission, RoutinePlace, RoutineResult, RoutineRun, RunCause, RunId, RunPr,
    RunStatus, Trigger, WEBHOOK_PORT, next_fire, run_branch,
};
use treeix_core::settings::Settings;
use treeix_proto::chat::ChatAgent;
use treeix_proto::{
    CreateSession, Event, Request, Response, ServerMsg, SessionKind, SessionStatus,
};
use triggers::{Hit, Poller};

/// Schedules fire within this of their minute
const TICK: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_secs(60);
/// How often running runs' transcripts are read for the budget
const WATCH: Duration = Duration::from_secs(3);
// ponytail: runs.jsonl is rewritten whole on each change, capped here; append + compaction if it shows up
const KEEP_RUNS: usize = 1000;
const ASLEEP: &str = "The Mac was asleep";
/// Denied to every run: Treeix pushes and opens the PR itself (`deliver`)
const WRITES: [&str; 10] = [
    "Bash(git push:*)",
    "Bash(gh pr create:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh pr close:*)",
    "Bash(gh pr edit:*)",
    "Bash(gh pr ready:*)",
    "Bash(gh api:*)",
    "Bash(glab mr create:*)",
    "Bash(glab mr merge:*)",
    "Bash(glab api:*)",
];
/// Allowed with `may_comment`, denied otherwise
const COMMENTS: [&str; 4] = [
    "Bash(gh pr comment:*)",
    "Bash(gh pr review:*)",
    "Bash(gh issue comment:*)",
    "Bash(glab mr note:*)",
];
const NO_PUSH: &str = "Do not push or open pull requests.";
const COMMIT: &str = "Commit your changes on the current branch: Treeix pushes them and opens or updates the pull request after you finish. Do not push or open pull requests yourself.";
const NO_COMMENTS: &str = "Do not post comments or reviews.";

/// Routines, their runs and the run queue (settings.routines.maxParallel slots)
#[derive(Default)]
pub struct Routines {
    dir: PathBuf,
    state: Mutex<State>,
    webhook: Mutex<Option<AbortHandle>>,
}

#[derive(Default)]
struct State {
    routines: Vec<Routine>,
    /// Oldest first
    runs: Vec<RoutineRun>,
    saved: Saved,
    /// Clocks at the last tick of this process
    clock: Option<Clock>,
}

/// `routines/engine.json`
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Saved {
    /// Wall clock of the last tick; a later start counts the time since as asleep
    last_tick: Option<u64>,
    /// What each queued run fired with
    queued: HashMap<RunId, Hit>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 128 random bits for a webhook URL
fn new_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A v4 UUID, what `claude --session-id` takes
fn new_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn ended(status: RunStatus) -> bool {
    !matches!(status, RunStatus::Queued | RunStatus::Running)
}

impl Routines {
    /// Reads routines.json; runs that were Running when ptyd died end Failed
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("routines");
        let _ = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir);
        let read = |name: &str| fs::read(dir.join(name)).ok();
        let routines = read("routines.json")
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let runs = read("runs.jsonl")
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect()
            })
            .unwrap_or_default();
        let saved = read("engine.json")
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let this = Self {
            dir,
            state: Mutex::new(State {
                routines,
                runs,
                saved,
                clock: None,
            }),
            webhook: Mutex::default(),
        };
        {
            let mut state = lock(&this.state);
            let now = now_ms();
            for run in state.runs.iter_mut() {
                if run.status == RunStatus::Running {
                    run.status = RunStatus::Failed;
                    run.ended_at = Some(now);
                    run.error = Some("Treeix's background service stopped during the run".into());
                }
            }
            this.save_runs(&state);
        }
        this
    }

    /// Daemon stop: queued runs stay queued for the next start, running ones are recorded as they are
    pub fn stop(&self) {
        if let Some(webhook) = lock(&self.webhook).take() {
            webhook.abort();
        }
        self.save_engine(&lock(&self.state));
    }

    fn save_routines(&self, state: &State) {
        let saved = serde_json::to_vec_pretty(&state.routines)
            .map_err(|e| e.to_string())
            .and_then(|json| write_atomic(&self.dir.join("routines.json"), &json));
        if let Err(e) = saved {
            tracing::error!("saving routines.json: {e}");
        }
    }

    fn save_runs(&self, state: &State) {
        let mut text = String::new();
        for run in &state.runs {
            if let Ok(line) = serde_json::to_string(run) {
                text.push_str(&line);
                text.push('\n');
            }
        }
        if let Err(e) = write_atomic(&self.dir.join("runs.jsonl"), text.as_bytes()) {
            tracing::error!("saving runs.jsonl: {e}");
        }
    }

    fn save_engine(&self, state: &State) {
        let saved = serde_json::to_vec(&state.saved)
            .map_err(|e| e.to_string())
            .and_then(|json| write_atomic(&self.dir.join("engine.json"), &json));
        if let Err(e) = saved {
            tracing::error!("saving engine.json: {e}");
        }
    }

    pub fn list(&self) -> Vec<Routine> {
        lock(&self.state).routines.clone()
    }

    pub fn get(&self, id: &str) -> Option<Routine> {
        lock(&self.state)
            .routines
            .iter()
            .find(|r| r.id == id)
            .cloned()
    }

    /// Creates (empty id) or replaces; fills id, created_at and a webhook token
    pub fn put(&self, mut routine: Routine) -> Result<Routine, String> {
        routine.name = routine.name.trim().to_owned();
        if routine.name.is_empty() {
            return Err("A routine needs a name".into());
        }
        match &mut routine.trigger {
            Trigger::Schedule { cron } => {
                next_fire(cron, now_ms())?;
            }
            Trigger::Webhook { token } if token.is_empty() => *token = new_token(),
            _ => {}
        }
        match (routine.result, routine.place) {
            (RoutineResult::DraftPr, place) if place != RoutinePlace::NewWorktree => {
                return Err("A draft PR needs a new worktree per run".into());
            }
            (RoutineResult::PushToPr, place) if place != RoutinePlace::PrWorktree => {
                return Err("Pushing to the PR needs the PR's worktree".into());
            }
            _ => {}
        }
        let mut state = lock(&self.state);
        match state.routines.iter_mut().find(|r| r.id == routine.id) {
            Some(existing) if !routine.id.is_empty() => {
                routine.created_at = existing.created_at;
                *existing = routine.clone();
            }
            _ if !routine.id.is_empty() => return Err(format!("no routine {}", routine.id)),
            _ => {
                routine.id = new_id();
                routine.created_at = now_ms();
                state.routines.push(routine.clone());
            }
        }
        state
            .routines
            .sort_by_cached_key(|r| (r.name.to_lowercase(), r.id.clone()));
        self.save_routines(&state);
        Ok(routine)
    }

    /// Drops the routine and its queued runs; the runs it made stay
    pub fn remove(&self, id: &str) -> Result<Vec<RoutineRun>, String> {
        let mut state = lock(&self.state);
        let before = state.routines.len();
        state.routines.retain(|r| r.id != id);
        if state.routines.len() == before {
            return Err(format!("no routine {id}"));
        }
        self.save_routines(&state);
        let queued: Vec<RunId> = state
            .runs
            .iter()
            .filter(|r| r.routine == id && r.status == RunStatus::Queued)
            .map(|r| r.id.clone())
            .collect();
        drop(state);
        Ok(queued
            .iter()
            .filter_map(|run| {
                self.end(
                    run,
                    RunStatus::Cancelled,
                    Some("The routine was removed".into()),
                )
            })
            .collect())
    }

    /// Newest first, at most `limit`
    pub fn runs(&self, routine: Option<&str>, limit: u32) -> Vec<RoutineRun> {
        lock(&self.state)
            .runs
            .iter()
            .rev()
            .filter(|r| routine.is_none_or(|id| r.routine == id))
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn run(&self, id: &str) -> Option<RoutineRun> {
        lock(&self.state).runs.iter().find(|r| r.id == id).cloned()
    }

    /// Queues a run, or records it Skipped with `skip` as the reason
    pub fn enqueue(
        &self,
        hit: Hit,
        due_at: u64,
        skip: Option<String>,
    ) -> Result<RoutineRun, String> {
        let mut state = lock(&self.state);
        let routine = state
            .routines
            .iter()
            .find(|r| r.id == hit.routine)
            .ok_or_else(|| format!("no routine {}", hit.routine))?;
        let run = RoutineRun {
            id: new_id(),
            routine: routine.id.clone(),
            name: routine.name.clone(),
            cause: hit.cause,
            status: if skip.is_some() {
                RunStatus::Skipped
            } else {
                RunStatus::Queued
            },
            detail: hit.detail.clone(),
            due_at,
            started_at: None,
            ended_at: skip.is_some().then(now_ms),
            session: None,
            cwd: None,
            turns: 0,
            cost: 0.0,
            error: skip,
            branch: None,
            pr: None,
            summary: None,
        };
        if run.status == RunStatus::Queued {
            state.saved.queued.insert(run.id.clone(), hit);
            self.save_engine(&state);
        }
        state.runs.push(run.clone());
        let over = state.runs.len().saturating_sub(KEEP_RUNS);
        state.runs.drain(..over);
        self.save_runs(&state);
        Ok(run)
    }

    /// Queued runs that fit in `max` slots, oldest first, now Running
    pub fn take_startable(&self, max: usize) -> Vec<(RoutineRun, Routine, Hit)> {
        let mut state = lock(&self.state);
        let State {
            routines,
            runs,
            saved,
            ..
        } = &mut *state;
        let running = runs
            .iter()
            .filter(|r| r.status == RunStatus::Running)
            .count();
        let mut started = Vec::new();
        for run in runs.iter_mut().filter(|r| r.status == RunStatus::Queued) {
            if running + started.len() >= max {
                break;
            }
            let (Some(routine), Some(hit)) = (
                routines.iter().find(|r| r.id == run.routine),
                saved.queued.remove(&run.id),
            ) else {
                run.status = RunStatus::Cancelled;
                run.ended_at = Some(now_ms());
                continue;
            };
            run.status = RunStatus::Running;
            run.started_at = Some(now_ms());
            started.push((run.clone(), routine.clone(), hit));
        }
        if !started.is_empty() {
            self.save_runs(&state);
            self.save_engine(&state);
        }
        started
    }

    /// Changes a run that has not ended; the changed run, None when it had ended or is unknown
    pub fn update(&self, id: &str, change: impl FnOnce(&mut RoutineRun)) -> Option<RoutineRun> {
        let mut state = lock(&self.state);
        let run = state
            .runs
            .iter_mut()
            .find(|r| r.id == id && !ended(r.status))?;
        let before = run.clone();
        change(run);
        let run = run.clone();
        if run != before {
            self.save_runs(&state);
        }
        Some(run)
    }

    /// Ends a queued or running run
    pub fn end(&self, id: &str, status: RunStatus, error: Option<String>) -> Option<RoutineRun> {
        let run = self.update(id, |run| {
            run.status = status;
            run.ended_at = Some(now_ms());
            run.error = error;
        })?;
        let mut state = lock(&self.state);
        if state.saved.queued.remove(id).is_some() {
            self.save_engine(&state);
        }
        Some(run)
    }

    pub fn running(&self) -> Vec<RoutineRun> {
        lock(&self.state)
            .runs
            .iter()
            .filter(|r| r.status == RunStatus::Running)
            .cloned()
            .collect()
    }

    /// The schedules due since the last tick. The first tick after a start or a sleep counts the gap as
    /// asleep; inactive (feature off, or no app and no background), time passes without firing
    pub fn tick(&self, now: Clock, active: bool) -> Vec<Due> {
        let mut state = lock(&self.state);
        let now_ms = now.wall_ms();
        let (last_ms, asleep) = match (state.clock, state.saved.last_tick) {
            (Some(last), _) => (last.wall_ms(), last.slept(&now).is_some()),
            (None, Some(saved)) => (saved, true),
            (None, None) => (now_ms, false),
        };
        state.clock = Some(now);
        state.saved.last_tick = Some(now_ms);
        self.save_engine(&state);
        if !active || now_ms <= last_ms {
            return vec![];
        }
        schedule::due(&state.routines, last_ms, now_ms, asleep)
    }
}

/// Firing does work only while the feature is on and either an app is connected or background runs are
fn active(daemon: &Daemon) -> (bool, Settings) {
    let settings = treeix_core::settings::load(&daemon.data_dir);
    let active =
        settings.features.routines && (settings.routines.background || daemon.has_clients());
    (active, settings)
}

fn changed(daemon: &Daemon, run: RoutineRun) {
    daemon.broadcast(Event::RunChanged(run));
}

/// Queues (or records skipped) a run and starts what fits
fn fire(
    daemon: &Arc<Daemon>,
    hit: Hit,
    due_at: u64,
    skip: Option<String>,
) -> Result<RoutineRun, String> {
    let run = daemon.routines.enqueue(hit, due_at, skip)?;
    changed(daemon, run.clone());
    pump(daemon);
    Ok(daemon.routines.run(&run.id).unwrap_or(run))
}

/// Starts queued runs while slots are free
fn pump(daemon: &Arc<Daemon>) {
    let max = treeix_core::settings::load(&daemon.data_dir)
        .routines
        .max_parallel
        .max(1) as usize;
    for (run, routine, hit) in daemon.routines.take_startable(max) {
        changed(daemon, run.clone());
        tokio::spawn(start(daemon.clone(), run, routine, hit));
    }
}

async fn start(daemon: Arc<Daemon>, run: RoutineRun, routine: Routine, hit: Hit) {
    let prompt = triggers::render(&routine.prompt, &hit.vars);
    usage::refresh_prices(&daemon.data_dir).await;
    let last_pr = (routine.result == RoutineResult::DraftPr)
        .then(|| {
            daemon
                .routines
                .runs(Some(&routine.id), KEEP_RUNS as u32)
                .into_iter()
                .find(|r| r.pr.is_some())
        })
        .flatten();
    let prepared = tokio::task::spawn_blocking(move || {
        let placed = place(&routine, &hit, last_pr.as_ref())?;
        let conversation = (routine.agent == ChatAgent::Claude).then(new_uuid);
        let command = command(&routine, &prompt, conversation.as_deref());
        Ok::<_, String>((routine, placed, command, conversation))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|prepared| prepared);
    let (routine, Placed { cwd, branch, pr }, command, conversation) = match prepared {
        Ok(prepared) => prepared,
        Err(e) => return finish(&daemon, &run.id, RunStatus::Failed, Some(e)),
    };
    let create = CreateSession {
        kind: SessionKind::Routine,
        cwd: Some(cwd.clone()),
        command,
        env: vec![],
        cols: 120,
        rows: 32,
        title: Some(routine.name.clone()),
        routine: Some(routine.id.clone()),
    };
    let info = match daemon.create(create) {
        Ok(info) => info,
        Err(e) => return finish(&daemon, &run.id, RunStatus::Failed, Some(format!("{e:#}"))),
    };
    if let (Some(conversation), Ok(session)) = (conversation, daemon.session(&info.id))
        && session.set_agent_session(&conversation)
    {
        daemon.broadcast(Event::AgentSession {
            session: info.id.clone(),
            agent_session: conversation,
        });
    }
    match daemon.routines.update(&run.id, |run| {
        run.session = Some(info.id.clone());
        run.cwd = Some(cwd);
        run.branch = branch;
        run.pr = pr;
    }) {
        Some(run) => changed(&daemon, run),
        // Cancelled while it was being set up
        None => {
            if let Ok(session) = daemon.session(&info.id) {
                session.kill();
            }
        }
    }
}

/// Where a run happens, and the branch and PR it delivers to
struct Placed {
    cwd: String,
    branch: Option<String>,
    pr: Option<RunPr>,
}

/// The repo, a fresh worktree (or the one of the routine's still open draft PR), or the PR's worktree
fn place(routine: &Routine, hit: &Hit, last_pr: Option<&RoutineRun>) -> Result<Placed, String> {
    let repo = hit
        .repo
        .clone()
        .or_else(|| routine.repo.clone())
        .ok_or("The routine has no repo to run in")?;
    if !Path::new(&repo).is_dir() {
        return Err(format!("{repo} is gone"));
    }
    let request = |branch: Option<String>, pr: Option<u32>| NewWorktree {
        repo_path: repo.clone(),
        branch,
        base: None,
        pr,
        copy_env: true,
        setup: None,
        skip_fetch: false,
    };
    let add = |request: NewWorktree| {
        git::add_worktree(&request, |_| {}).or_else(|e| {
            // Just woken, the network may not be back yet: a branch can start from the last fetched base
            if request.branch.is_none() {
                return Err(e);
            }
            tracing::info!("routine worktree without fetching: {e}");
            git::add_worktree(
                &NewWorktree {
                    skip_fetch: true,
                    ..request
                },
                |_| {},
            )
        })
    };
    match routine.place {
        RoutinePlace::Root => Ok(Placed {
            cwd: repo,
            branch: None,
            pr: None,
        }),
        RoutinePlace::NewWorktree => {
            if let Some((branch, pr)) = open_pr(&repo, last_pr)? {
                let cwd = git::add_worktree(&request(Some(branch.clone()), None), |_| {})?;
                git::catch_up(&cwd, &branch)?;
                return Ok(Placed {
                    cwd,
                    branch: Some(branch),
                    pr: Some(pr),
                });
            }
            let branch = run_branch(&routine.name, now_ms());
            Ok(Placed {
                cwd: add(request(Some(branch.clone()), None))?,
                branch: Some(branch),
                pr: None,
            })
        }
        RoutinePlace::PrWorktree => {
            let number = hit
                .pr
                .and_then(|pr| u32::try_from(pr).ok())
                .ok_or("Only PR events run in a PR's worktree")?;
            let cwd = add(request(None, Some(number)))?;
            if routine.result != RoutineResult::PushToPr {
                return Ok(Placed {
                    cwd,
                    branch: None,
                    pr: None,
                });
            }
            // A reused worktree is where the last run left it: start from what the PR has now
            let found = prs::pull_request(&repo, number)?;
            git::catch_up(&cwd, &found.source_branch)?;
            Ok(Placed {
                cwd,
                branch: Some(found.source_branch),
                pr: Some(RunPr {
                    number,
                    url: found.url,
                }),
            })
        }
    }
}

/// The branch and PR of an earlier run while that PR is open; once it's merged or closed its clean worktree goes
fn open_pr(repo: &str, last: Option<&RoutineRun>) -> Result<Option<(String, RunPr)>, String> {
    let Some((last, branch, pr)) = last.and_then(|r| Some((r, r.branch.clone()?, r.pr.clone()?)))
    else {
        return Ok(None);
    };
    if prs::pull_request(repo, pr.number)?.state == PrState::Open {
        return Ok(Some((branch, pr)));
    }
    if let Some(cwd) = last.cwd.as_deref().filter(|cwd| Path::new(cwd).is_dir())
        && let Err(e) = git::remove_worktree(cwd, false, true)
    {
        tracing::info!("worktree of a closed routine PR kept: {e}");
    }
    Ok(None)
}

/// After a clean exit: drops a new worktree the run left untouched, pushes, and opens the draft PR
fn deliver(
    routine: &Routine,
    run: &RoutineRun,
    summary: Option<&str>,
) -> Result<Option<RunPr>, String> {
    let (Some(cwd), Some(branch)) = (run.cwd.as_deref(), run.branch.as_deref()) else {
        return Ok(None);
    };
    if !Path::new(cwd).is_dir() {
        return Err(format!("{cwd} is gone"));
    }
    let dirty = git::git_status(cwd)?.is_some_and(|status| !status.changes.is_empty());
    if dirty && routine.result != RoutineResult::Local {
        // Agents forget, and Codex's sandbox can't write a worktree's git dir: what's left is committed for them
        git::commit_all(cwd, &routine.name)?;
    }
    if routine.result == RoutineResult::PushToPr {
        git::push(cwd, branch)?;
        return Ok(run.pr.clone());
    }
    let (base, commits) = git::commits_ahead(cwd)?;
    if commits.is_empty() {
        if !dirty {
            git::remove_worktree(cwd, false, true)?;
        }
        return Ok(None);
    }
    if routine.result == RoutineResult::Local {
        return Ok(None);
    }
    git::push(cwd, branch)?;
    if let Some(pr) = &run.pr {
        return Ok(Some(pr.clone()));
    }
    let footer = format!("Opened by the Treeix routine **{}**.", routine.name);
    let body = summary.map_or(footer.clone(), |summary| {
        format!("{summary}\n\n---\n{footer}")
    });
    let (number, url) = prs::open_draft_pr(cwd, branch, &base, &commits[0], &body)?;
    Ok(Some(RunPr { number, url }))
}

/// The agent's command line, run through the login shell so a daemon started without the user's PATH finds it
fn command(routine: &Routine, prompt: &str, conversation: Option<&str>) -> Vec<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut args: Vec<String> = vec![
        shell,
        "-lc".into(),
        "exec \"$@\"".into(),
        "treeix-routine".into(),
    ];
    let rules = match routine.result {
        RoutineResult::Local => NO_PUSH,
        RoutineResult::DraftPr | RoutineResult::PushToPr => COMMIT,
    };
    let prompt = if routine.may_comment {
        format!("{prompt}\n\n{rules}")
    } else {
        format!("{prompt}\n\n{rules} {NO_COMMENTS}")
    };
    let owned = |tools: &[&str]| tools.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>();
    match routine.agent {
        ChatAgent::Claude => {
            args.extend(["claude".into(), "-p".into()]);
            if let Some(id) = conversation {
                args.extend(["--session-id".into(), id.into()]);
            }
            let mode = match routine.permission {
                RoutinePermission::ReadOnly => "plan",
                RoutinePermission::EditFiles => "acceptEdits",
                RoutinePermission::Anything => "bypassPermissions",
            };
            args.extend(["--permission-mode".into(), mode.into()]);
            if let Some(turns) = routine.budget.max_turns {
                args.extend(["--max-turns".into(), turns.to_string()]);
            }
            let mut allowed = routine.allowed_tools.clone();
            let mut denied = owned(&WRITES);
            if routine.may_comment {
                allowed.extend(owned(&COMMENTS));
            } else {
                denied.extend(owned(&COMMENTS));
            }
            args.push("--disallowedTools".into());
            args.extend(denied);
            if !allowed.is_empty() {
                args.push("--allowedTools".into());
                args.extend(allowed);
            }
        }
        ChatAgent::Codex => {
            let sandbox = match routine.permission {
                RoutinePermission::ReadOnly => "read-only",
                RoutinePermission::EditFiles => "workspace-write",
                RoutinePermission::Anything => "danger-full-access",
            };
            args.extend([
                "codex".into(),
                "exec".into(),
                "--sandbox".into(),
                sandbox.into(),
            ]);
        }
    }
    args.extend(["--".into(), prompt]);
    args
}

/// Ends a run, records it in History and starts the next queued one
fn finish(daemon: &Arc<Daemon>, run: &str, status: RunStatus, error: Option<String>) {
    let Some(run) = daemon.routines.end(run, status, error) else {
        return;
    };
    changed(daemon, run.clone());
    if let Some(session) = run.session.as_deref().and_then(|s| daemon.session(s).ok()) {
        let (daemon, info) = (daemon.clone(), session.info());
        tokio::task::spawn_blocking(move || record(&daemon, &run, info));
    }
    pump(daemon);
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

fn agent_kind(routine: Option<&Routine>, info: &treeix_proto::SessionInfo) -> AgentKind {
    let codex = routine.map_or_else(
        || info.command.iter().any(|a| a == "codex"),
        |r| r.agent == ChatAgent::Codex,
    );
    if codex {
        AgentKind::Codex
    } else {
        AgentKind::Claude
    }
}

/// The run's History record, written once it ended (the app keeps no record of routine sessions)
fn record(daemon: &Daemon, run: &RoutineRun, info: treeix_proto::SessionInfo) {
    let home = home();
    let kind = agent_kind(daemon.routines.get(&run.routine).as_ref(), &info);
    let place = treeix_core::places::resolve(Path::new(&info.cwd), &home);
    let stats = info
        .agent_session
        .as_deref()
        .and_then(|id| transcripts::transcript_path(&home, kind, id))
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| transcripts::transcript_stats(kind, &text));
    let record = SessionRecord {
        id: info.id,
        kind: match kind {
            AgentKind::Claude => RecordKind::Claude,
            AgentKind::Codex => RecordKind::Codex,
        },
        title: run.name.clone(),
        cwd: info.cwd,
        branch: place.branch,
        repo_root: place.repo_root,
        agent_session: info.agent_session,
        command: info.command,
        created_at: info.created_at,
        closed_at: now_ms(),
        messages: stats.as_ref().map(|s| s.messages),
        cost: Some(run.cost),
        first_prompt: stats.and_then(|s| s.first_prompt),
        run: Some(run.id.clone()),
    };
    if let Err(e) = history::record_session(&daemon.data_dir.join("sessions.jsonl"), &record) {
        tracing::warn!("run {} not recorded: {e}", run.id);
    }
}

/// One look at a running run: its spend so far, the budget, and whether its agent exited
fn watch_run(daemon: &Arc<Daemon>, run: &RoutineRun, prices: &BTreeMap<String, usage::Price>) {
    let Some(session_id) = &run.session else {
        return;
    };
    let Ok(session) = daemon.session(session_id) else {
        return finish(
            daemon,
            &run.id,
            RunStatus::Cancelled,
            Some("The tab was closed".into()),
        );
    };
    let routine = daemon.routines.get(&run.routine);
    let mut info = session.info();
    let kind = agent_kind(routine.as_ref(), &info);
    let home = home();
    if info.agent_session.is_none() && kind == AgentKind::Codex {
        // Codex names its rollout itself: the oldest one in the run's folder since it started that no session has
        let taken: Vec<String> = daemon
            .sessions()
            .iter()
            .filter_map(|s| s.info().agent_session)
            .collect();
        let since = run
            .started_at
            .unwrap_or(info.created_at)
            .saturating_sub(5000);
        if let Some(found) = codex::codex_conversations(&home, &info.cwd, since)
            .into_iter()
            .map(|c| c.id)
            .find(|id| !taken.contains(id))
            && session.set_agent_session(&found)
        {
            daemon.broadcast(Event::AgentSession {
                session: session_id.clone(),
                agent_session: found.clone(),
            });
            info.agent_session = Some(found);
        }
    }
    let agent = match kind {
        AgentKind::Claude => ChatAgent::Claude,
        AgentKind::Codex => ChatAgent::Codex,
    };
    let transcript = info
        .agent_session
        .as_deref()
        .and_then(|id| transcripts::transcript_path(&home, kind, id))
        .and_then(|path| fs::read_to_string(path).ok());
    let spent = transcript
        .as_deref()
        .map(|text| budget::spent(agent, text, prices));
    if let Some(spent) = spent
        && let Some(run) = daemon.routines.update(&run.id, |run| {
            run.turns = spent.turns;
            run.cost = spent.cost;
        })
        && (run.turns, run.cost) != (spent.turns, spent.cost)
    {
        changed(daemon, run);
    }
    let spent = spent.unwrap_or(budget::Spent {
        turns: run.turns,
        cost: run.cost,
    });
    let limits = routine.as_ref().map(|r| r.budget).unwrap_or_default();
    if info.status == SessionStatus::Exited {
        let summary = transcript
            .as_deref()
            .and_then(|text| transcripts::last_replies(kind, text, 1).pop());
        let Some(run) = daemon.routines.update(&run.id, |run| {
            run.summary.clone_from(&summary);
        }) else {
            return;
        };
        let delivered = match (info.exit_code, &routine) {
            (Some(0), Some(routine)) => deliver(routine, &run, summary.as_deref()),
            _ => Ok(None),
        };
        let (status, error) = match info.exit_code {
            Some(0) => match delivered {
                Ok(pr) => {
                    daemon.routines.update(&run.id, |run| run.pr = pr);
                    (RunStatus::Ok, None)
                }
                Err(e) => (RunStatus::Failed, Some(e)),
            },
            _ if limits.max_turns.is_some_and(|max| spent.turns >= max) => (
                RunStatus::OverBudget,
                limits
                    .max_turns
                    .map(|max| format!("Stopped after {max} turns")),
            ),
            Some(code) => (
                RunStatus::Failed,
                Some(format!("The agent exited with code {code}")),
            ),
            None => (RunStatus::Failed, Some("The agent was killed".into())),
        };
        return finish(daemon, &run.id, status, error);
    }
    if let Some(reason) = budget::breach(&limits, spent) {
        session.kill();
        finish(daemon, &run.id, RunStatus::OverBudget, Some(reason));
    }
}

/// Keeps the webhook listener up exactly while an enabled webhook routine exists and the feature is on
fn webhook_listener(daemon: &Arc<Daemon>, settings: &Settings) {
    let wanted = settings.features.routines
        && daemon
            .routines
            .list()
            .iter()
            .any(|r| r.enabled && matches!(r.trigger, Trigger::Webhook { .. }));
    let mut webhook = lock(&daemon.routines.webhook);
    match (wanted, webhook.is_some()) {
        (true, false) => {
            let std_listener = match std::net::TcpListener::bind(("127.0.0.1", WEBHOOK_PORT))
                .and_then(|l| l.set_nonblocking(true).map(|()| l))
            {
                Ok(listener) => listener,
                Err(e) => {
                    // Retried on the next tick
                    tracing::warn!("webhook port {WEBHOOK_PORT}: {e}");
                    return;
                }
            };
            let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) else {
                return;
            };
            let weak = Arc::downgrade(daemon);
            let fire_hook = move |token: &str, body: String| {
                let daemon = weak.upgrade().ok_or(503u16)?;
                if !active(&daemon).0 {
                    return Err(503);
                }
                let routines = daemon.routines.list();
                let routine = triggers::by_token(&routines, token).ok_or(404u16)?;
                let detail = body
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .map(|l| l.trim().chars().take(80).collect());
                let hit = Hit {
                    routine: routine.id.clone(),
                    cause: RunCause::Webhook,
                    detail,
                    vars: BTreeMap::from([("body".to_owned(), body)]),
                    repo: None,
                    pr: None,
                };
                fire(&daemon, hit, now_ms(), None)
                    .map(|run| run.id)
                    .map_err(|_| 404)
            };
            *webhook =
                Some(tokio::spawn(triggers::serve_webhooks(listener, fire_hook)).abort_handle());
        }
        (false, true) => {
            if let Some(handle) = webhook.take() {
                handle.abort();
            }
        }
        _ => {}
    }
}

/// Every `Request::Routine*` and `Request::RunCancel`. Replies on `outbox` itself, so slow work (git worktree,
/// file writes) can move off the socket task; changes broadcast RoutineChanged, RoutineRemoved, RunChanged
pub fn handle(daemon: &Arc<Daemon>, outbox: &Outbox, id: u64, req: Request) {
    let resp = respond(daemon, req);
    let _ = outbox.send(ServerMsg::Resp { id, resp });
}

fn respond(daemon: &Arc<Daemon>, req: Request) -> Result<Response, String> {
    let routines = &daemon.routines;
    match req {
        Request::RoutineList => Ok(Response::Routines(routines.list())),
        Request::RoutinePut { routine } => {
            let routine = routines.put(routine)?;
            daemon.broadcast(Event::RoutineChanged(routine.clone()));
            webhook_listener(daemon, &active(daemon).1);
            Ok(Response::Routine(routine))
        }
        Request::RoutineRemove { routine } => {
            for run in routines.remove(&routine)? {
                changed(daemon, run);
            }
            daemon.broadcast(Event::RoutineRemoved { routine });
            webhook_listener(daemon, &active(daemon).1);
            Ok(Response::Ok)
        }
        Request::RoutineRunNow { routine } => {
            let hit = Hit {
                routine,
                cause: RunCause::Manual,
                detail: None,
                vars: BTreeMap::new(),
                repo: None,
                pr: None,
            };
            fire(daemon, hit, now_ms(), None).map(Response::Run)
        }
        Request::RoutineRuns { routine, limit } => {
            Ok(Response::Runs(routines.runs(routine.as_deref(), limit)))
        }
        Request::RunCancel { run } => {
            let found = routines.run(&run).ok_or_else(|| format!("no run {run}"))?;
            if ended(found.status) {
                return Err("The run already ended".into());
            }
            if let Some(session) = found
                .session
                .as_deref()
                .and_then(|s| daemon.session(s).ok())
            {
                session.kill();
            }
            finish(daemon, &run, RunStatus::Cancelled, None);
            Ok(Response::Ok)
        }
        other => Err(format!("not a routine request: {other:?}")),
    }
}

/// Repos a `repo: None` routine's PR event may run in: the routines' own and the open sessions'
fn checkouts(daemon: &Daemon) -> Vec<String> {
    let home = home();
    let mut repos: Vec<String> = daemon
        .routines
        .list()
        .into_iter()
        .filter_map(|r| r.repo)
        .chain(daemon.sessions().iter().filter_map(|s| {
            treeix_core::places::resolve(Path::new(&s.info().cwd), &home).repo_root
        }))
        .collect();
    repos.sort();
    repos.dedup();
    repos
}

/// From `Daemon::spawn_timers`: the schedule tick and wake check (schedule.rs), the 60 s gh/acli pollers and the
/// webhook listener (triggers.rs), the budget watch of running runs (budget.rs)
pub fn spawn(daemon: &Arc<Daemon>) {
    let d = daemon.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(TICK);
        every.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if d.stopping() {
                return;
            }
            let (active, settings) = active(&d);
            for due in d.routines.tick(Clock::now(), active) {
                let hit = Hit {
                    routine: due.routine,
                    cause: due.cause,
                    detail: None,
                    vars: BTreeMap::new(),
                    repo: None,
                    pr: None,
                };
                if let Err(e) = fire(&d, hit, due.due_at, due.skip.then(|| ASLEEP.to_owned())) {
                    tracing::warn!("routine not fired: {e}");
                }
            }
            webhook_listener(&d, &settings);
            pump(&d);
        }
    });

    let d = daemon.clone();
    tokio::spawn(async move {
        let mut poller = Some(Poller::load(&d.routines.dir));
        let mut every = tokio::time::interval(POLL);
        every.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if d.stopping() {
                return;
            }
            let routines = d.routines.list();
            let Some(mut taken) = poller.take() else {
                return;
            };
            let worked = if active(&d).0 {
                let d = d.clone();
                tokio::task::spawn_blocking(move || {
                    let mut hits = taken.poll(&routines, &checkouts(&d));
                    Poller::describe(&mut hits);
                    taken.save(&d.routines.dir);
                    (taken, hits)
                })
                .await
            } else {
                // Nothing fires meanwhile, and events from then must not fire later
                taken.primed.clear();
                Ok((taken, vec![]))
            };
            let Ok((back, hits)) = worked else {
                return;
            };
            poller = Some(back);
            for hit in hits {
                if let Err(e) = fire(&d, hit, now_ms(), None) {
                    tracing::warn!("routine not fired: {e}");
                }
            }
        }
    });

    let d = daemon.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(WATCH);
        every.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if d.stopping() {
                return;
            }
            let running = d.routines.running();
            if running.is_empty() {
                continue;
            }
            let d = d.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let prices = budget::prices(&d.data_dir);
                for run in &running {
                    watch_run(&d, run, &prices);
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::schedule::tests::{MINUTE, T0, routine};
    use super::*;
    use std::time::Instant;
    use treeix_core::routines::{Budget, WhileAsleep};

    fn engine(routines: Vec<Routine>) -> (tempfile::TempDir, Routines) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Routines::load(dir.path());
        lock(&engine.state).routines = routines;
        (dir, engine)
    }

    fn clock(wall_ms: u64, mono: Instant) -> Clock {
        Clock {
            wall: UNIX_EPOCH + Duration::from_millis(wall_ms),
            mono,
        }
    }

    fn manual(routine: &str) -> Hit {
        Hit {
            routine: routine.into(),
            cause: RunCause::Manual,
            detail: None,
            vars: BTreeMap::new(),
            repo: None,
            pr: None,
        }
    }

    #[test]
    fn a_two_hour_sleep_catches_up_exactly_once() {
        let (_dir, engine) = engine(vec![
            routine("hourly", "0 * * * *", WhileAsleep::CatchUp),
            routine("quarter", "*/15 * * * *", WhileAsleep::Skip),
        ]);
        let mono = Instant::now();
        assert!(engine.tick(clock(T0 + 30_000, mono), true).is_empty());
        // Lid closed for two hours: the monotonic clock stood still
        let woke = clock(T0 + 120 * MINUTE + 30_000, mono + Duration::from_secs(20));
        let due = engine.tick(woke, true);
        assert_eq!(due.len(), 2, "{due:?}");
        for due in &due {
            assert_eq!(due.cause, RunCause::CatchUp);
            assert_eq!(due.skip, due.routine == "quarter");
        }
        // The next ticks are awake and nothing is due again
        let mut mono = mono + Duration::from_secs(20);
        for n in 1..=3 {
            mono += TICK;
            let later = clock(woke.wall_ms() + n * TICK.as_millis() as u64, mono);
            assert!(engine.tick(later, true).is_empty());
        }
    }

    #[test]
    fn a_restart_counts_the_time_ptyd_was_down_as_asleep() {
        let (dir, engine) = engine(vec![routine("q", "*/15 * * * *", WhileAsleep::CatchUp)]);
        engine.save_routines(&lock(&engine.state));
        engine.tick(clock(T0 - MINUTE, Instant::now()), true);
        engine.stop();
        let restarted = Routines::load(dir.path());
        let due = restarted.tick(clock(T0 + 45 * MINUTE, Instant::now()), true);
        assert_eq!(due.len(), 1);
        assert_eq!(
            (due[0].cause, due[0].due_at),
            (RunCause::CatchUp, T0 + 45 * MINUTE)
        );
    }

    #[test]
    fn inactive_ticks_let_time_pass_without_firing() {
        let (_dir, engine) = engine(vec![routine("m", "* * * * *", WhileAsleep::CatchUp)]);
        let mono = Instant::now();
        engine.tick(clock(T0, mono), true);
        assert!(
            engine
                .tick(clock(T0 + MINUTE, mono + Duration::from_secs(60)), false)
                .is_empty()
        );
        let due = engine.tick(
            clock(T0 + 2 * MINUTE, mono + Duration::from_secs(120)),
            true,
        );
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].due_at, T0 + 2 * MINUTE);
    }

    #[test]
    fn the_queue_starts_no_more_than_max_parallel() {
        let (_dir, engine) = engine(vec![routine("r", "* * * * *", WhileAsleep::CatchUp)]);
        let runs: Vec<RoutineRun> = (0..3)
            .map(|_| engine.enqueue(manual("r"), T0, None).unwrap())
            .collect();
        let started = engine.take_startable(2);
        assert_eq!(started.len(), 2);
        assert_eq!(started[0].0.id, runs[0].id);
        assert!(engine.take_startable(2).is_empty());
        assert_eq!(engine.run(&runs[2].id).unwrap().status, RunStatus::Queued);

        engine.end(&runs[0].id, RunStatus::Ok, None).unwrap();
        let next = engine.take_startable(2);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].0.id, runs[2].id);
        assert_eq!(next[0].0.status, RunStatus::Running);
        // An ended run stays ended
        assert!(engine.end(&runs[0].id, RunStatus::Failed, None).is_none());
    }

    #[test]
    fn skipped_runs_are_recorded_and_never_queued() {
        let (_dir, engine) = engine(vec![routine("r", "* * * * *", WhileAsleep::Skip)]);
        let run = engine
            .enqueue(manual("r"), T0, Some(ASLEEP.into()))
            .unwrap();
        assert_eq!(run.status, RunStatus::Skipped);
        assert_eq!(run.error.as_deref(), Some(ASLEEP));
        assert!(engine.take_startable(5).is_empty());
    }

    #[test]
    fn runs_and_queued_hits_survive_a_restart_and_running_ones_fail() {
        let (dir, engine) = engine(vec![routine("r", "* * * * *", WhileAsleep::CatchUp)]);
        engine.save_routines(&lock(&engine.state));
        let running = engine.enqueue(manual("r"), T0, None).unwrap();
        engine.take_startable(1);
        let queued = engine.enqueue(manual("r"), T0, None).unwrap();
        let again = Routines::load(dir.path());
        assert_eq!(again.run(&running.id).unwrap().status, RunStatus::Failed);
        assert_eq!(again.runs(Some("r"), 1)[0].id, queued.id);
        let started = again.take_startable(1);
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].2, manual("r"));
    }

    #[test]
    fn put_fills_ids_and_tokens_and_rejects_bad_routines() {
        let (_dir, engine) = engine(vec![]);
        let mut hook = routine("", "* * * * *", WhileAsleep::CatchUp);
        hook.name = " Deploy ".into();
        hook.trigger = Trigger::Webhook {
            token: String::new(),
        };
        let saved = engine.put(hook).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(saved.name, "Deploy");
        assert!(saved.created_at > 0);
        let Trigger::Webhook { token } = &saved.trigger else {
            panic!()
        };
        assert_eq!(token.len(), 32);

        let mut renamed = saved.clone();
        renamed.created_at = 1;
        renamed.name = "Ship".into();
        let replaced = engine.put(renamed).unwrap();
        assert_eq!(
            (replaced.created_at, engine.list().len()),
            (saved.created_at, 1)
        );

        let mut nameless = routine("", "* * * * *", WhileAsleep::CatchUp);
        nameless.name = "  ".into();
        assert!(engine.put(nameless).is_err());
        let mut bad = routine("", "every day", WhileAsleep::CatchUp);
        bad.name = "Daily".into();
        assert!(engine.put(bad).unwrap_err().starts_with("invalid schedule"));
    }

    #[test]
    fn removing_a_routine_cancels_its_queued_runs() {
        let (_dir, engine) = engine(vec![routine("r", "* * * * *", WhileAsleep::CatchUp)]);
        let run = engine.enqueue(manual("r"), T0, None).unwrap();
        let cancelled = engine.remove("r").unwrap();
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].status, RunStatus::Cancelled);
        assert_eq!(engine.run(&run.id).unwrap().status, RunStatus::Cancelled);
        assert!(engine.remove("r").is_err());
    }

    fn args(routine: &Routine) -> Vec<String> {
        command(routine, "Review it", Some("uuid"))[4..].to_vec()
    }

    #[test]
    fn claude_runs_get_the_mode_turns_and_tools_of_the_routine() {
        let mut r = routine("r", "* * * * *", WhileAsleep::CatchUp);
        r.permission = RoutinePermission::EditFiles;
        r.budget = Budget {
            max_turns: Some(30),
            max_cost: Some(5.0),
        };
        r.allowed_tools = vec!["Bash(npm test:*)".into()];
        let line = args(&r);
        let at = |flag: &str| line.iter().position(|a| a == flag).unwrap();
        assert_eq!(&line[..2], ["claude", "-p"]);
        assert_eq!(line[at("--session-id") + 1], "uuid");
        assert_eq!(line[at("--permission-mode") + 1], "acceptEdits");
        assert_eq!(line[at("--max-turns") + 1], "30");
        assert_eq!(line[at("--allowedTools") + 1], "Bash(npm test:*)");
        let denied = &line[at("--disallowedTools") + 1..at("--allowedTools")];
        assert!(denied.contains(&"Bash(git push:*)".to_owned()));
        assert!(denied.contains(&"Bash(gh pr comment:*)".to_owned()));
        assert_eq!(line[line.len() - 2], "--");
        assert_eq!(
            line[line.len() - 1],
            format!("Review it\n\n{NO_PUSH} {NO_COMMENTS}")
        );

        r.may_comment = true;
        r.result = RoutineResult::DraftPr;
        let line = args(&r);
        let at = |flag: &str| line.iter().position(|a| a == flag).unwrap();
        let denied = &line[at("--disallowedTools") + 1..at("--allowedTools")];
        assert!(denied.contains(&"Bash(gh pr create:*)".to_owned()));
        assert!(!denied.contains(&"Bash(gh pr review:*)".to_owned()));
        assert!(line[at("--allowedTools")..].contains(&"Bash(gh pr review:*)".to_owned()));
        assert_eq!(line.last().unwrap(), &format!("Review it\n\n{COMMIT}"));
    }

    #[test]
    fn codex_runs_map_the_permission_to_a_sandbox() {
        let mut r = routine("r", "* * * * *", WhileAsleep::CatchUp);
        r.agent = ChatAgent::Codex;
        r.permission = RoutinePermission::Anything;
        r.may_comment = true;
        assert_eq!(
            args(&r),
            [
                "codex",
                "exec",
                "--sandbox",
                "danger-full-access",
                "--",
                &format!("Review it\n\n{NO_PUSH}")
            ]
        );
    }

    #[test]
    fn a_result_needs_its_place() {
        let (_dir, engine) = engine(vec![]);
        let mut r = routine("", "* * * * *", WhileAsleep::CatchUp);
        r.name = "Bump".into();
        r.result = RoutineResult::DraftPr;
        assert!(engine.put(r.clone()).is_err());
        r.place = RoutinePlace::NewWorktree;
        assert!(engine.put(r.clone()).is_ok());
        r.result = RoutineResult::PushToPr;
        assert!(engine.put(r).is_err());
    }

    /// git with a test identity; panics on failure
    fn git_in(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }

    fn run_in(cwd: &str, branch: &str) -> RoutineRun {
        RoutineRun {
            id: "run".into(),
            routine: "r".into(),
            name: "r".into(),
            cause: RunCause::Manual,
            status: RunStatus::Running,
            detail: None,
            due_at: 0,
            started_at: None,
            ended_at: None,
            session: None,
            cwd: Some(cwd.into()),
            turns: 0,
            cost: 0.0,
            error: None,
            branch: Some(branch.into()),
            pr: None,
            summary: None,
        }
    }

    #[test]
    fn delivery_drops_untouched_worktrees_and_pushes_commits() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let (origin, clone) = (root.join("origin"), root.join("clone"));
        fs::create_dir(&origin).unwrap();
        git_in(&origin, &["init", "-q", "-b", "main"]);
        git_in(&origin, &["commit", "-q", "--allow-empty", "-m", "root"]);
        git_in(&root, &["clone", "-q", "origin", "clone"]);
        // Treeix commits with the user's identity, which CI has none of
        for (key, value) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgsign", "false"),
        ] {
            git_in(&clone, &["config", key, value]);
        }
        let add = |branch: &str| {
            let request = NewWorktree {
                repo_path: clone.to_string_lossy().into_owned(),
                branch: Some(branch.into()),
                base: None,
                pr: None,
                copy_env: false,
                setup: None,
                skip_fetch: false,
            };
            git::add_worktree(&request, |_| {}).unwrap()
        };
        let mut r = routine("r", "* * * * *", WhileAsleep::CatchUp);
        r.place = RoutinePlace::NewWorktree;

        let untouched = add("routine/a");
        assert_eq!(
            deliver(&r, &run_in(&untouched, "routine/a"), None),
            Ok(None)
        );
        assert!(!Path::new(&untouched).exists());

        // Left uncommitted: committed for it. A later run of the routine whose draft PR is still open adds to it
        r.result = RoutineResult::DraftPr;
        let cwd = add("routine/b");
        fs::write(Path::new(&cwd).join("a.txt"), "one\n").unwrap();
        let pr = Some(RunPr {
            number: 3,
            url: "https://github.com/o/r/pull/3".into(),
        });
        let later = RoutineRun {
            pr: pr.clone(),
            ..run_in(&cwd, "routine/b")
        };
        assert_eq!(deliver(&r, &later, None), Ok(pr));
        assert_eq!(
            git_in(&origin, &["log", "-1", "--format=%s", "routine/b"]).trim(),
            "r"
        );
    }

    #[test]
    fn uuids_are_version_4() {
        let id = new_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }
}
