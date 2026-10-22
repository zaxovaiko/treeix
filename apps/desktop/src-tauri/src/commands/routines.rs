//! Routines: the app's side of the engine ptyd runs (crates/ptyd/src/routines). These only forward; changes
//! from ptyd go to every window as `RoutinesEvent`. Contract: docs/next/phase67-contract.md. Owner: R6 (engine),
//! U7 (UI)

use super::{Result, ok, unexpected};
use crate::daemon::Daemon;
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_specta::Event;
use treeix_core::routines::{Routine, RoutineId, RoutineRun, RunId};
use treeix_proto::{Request, Response};

/// A routine was created, changed or removed, or a run was queued, changed or ended, in any window
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RoutinesEvent {
    Changed { routine: Routine },
    Removed { routine: RoutineId },
    Run { run: RoutineRun },
}

/// Routine events from ptyd go to every window
pub(crate) fn on_routine_event(app: &AppHandle, event: treeix_proto::Event) {
    let event = match event {
        treeix_proto::Event::RoutineChanged(routine) => RoutinesEvent::Changed { routine },
        treeix_proto::Event::RoutineRemoved { routine } => RoutinesEvent::Removed { routine },
        treeix_proto::Event::RunChanged(run) => RoutinesEvent::Run { run },
        _ => return,
    };
    if let Err(e) = event.emit(app) {
        tracing::warn!("routines event not sent: {e}");
    }
}

#[tauri::command]
#[specta::specta]
pub async fn routine_list(daemon: State<'_, Arc<Daemon>>) -> Result<Vec<Routine>> {
    match daemon.request(Request::RoutineList).await? {
        Response::Routines(list) => Ok(list),
        other => Err(unexpected(other)),
    }
}

/// Creates (empty id) or replaces a routine; the reply has its id, createdAt and webhook token
#[tauri::command]
#[specta::specta]
pub async fn routine_put(daemon: State<'_, Arc<Daemon>>, routine: Routine) -> Result<Routine> {
    match daemon.request(Request::RoutinePut { routine }).await? {
        Response::Routine(routine) => Ok(routine),
        other => Err(unexpected(other)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn routine_remove(daemon: State<'_, Arc<Daemon>>, id: RoutineId) -> Result<()> {
    ok(&daemon, Request::RoutineRemove { routine: id }).await
}

/// Queues a manual run, even of a disabled routine
#[tauri::command]
#[specta::specta]
pub async fn routine_run_now(daemon: State<'_, Arc<Daemon>>, id: RoutineId) -> Result<RoutineRun> {
    match daemon
        .request(Request::RoutineRunNow { routine: id })
        .await?
    {
        Response::Run(run) => Ok(run),
        other => Err(unexpected(other)),
    }
}

/// Newest first; None lists every routine's
#[tauri::command]
#[specta::specta]
pub async fn routine_runs(
    daemon: State<'_, Arc<Daemon>>,
    routine: Option<RoutineId>,
    limit: u32,
) -> Result<Vec<RoutineRun>> {
    match daemon
        .request(Request::RoutineRuns { routine, limit })
        .await?
    {
        Response::Runs(runs) => Ok(runs),
        other => Err(unexpected(other)),
    }
}

/// Stops a queued or running run; it ends Cancelled
#[tauri::command]
#[specta::specta]
pub async fn routine_cancel_run(daemon: State<'_, Arc<Daemon>>, run: RunId) -> Result<()> {
    ok(&daemon, Request::RunCancel { run }).await
}

/// The schedule's next `count` fire times (unix ms) from now; rejects an invalid cron with what is wrong
#[tauri::command]
#[specta::specta]
pub fn routine_next_fires(cron: String, count: u32) -> Result<Vec<u64>> {
    let now = super::files::now_ms();
    treeix_core::routines::next_fires(&cron, now, count.min(20) as usize)
}
