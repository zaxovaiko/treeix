//! Claude Code's plans for the plan pane (treeix_core::plans). The pane re-lists on `watchPlace` of the plans
//! folder. Owner: G7

use super::Result;
use super::files::blocking;
use tauri::{AppHandle, Manager};
use treeix_core::plans::{self, PlanFile};

fn home(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path().home_dir().map_err(|e| e.to_string())
}

/// `~/.claude/plans/*.md`, newest first
#[tauri::command]
#[specta::specta]
pub async fn plans_list(app: AppHandle) -> Result<Vec<PlanFile>> {
    let home = home(&app)?;
    blocking(move || plans::list(&home)).await
}

/// A plan's markdown by file name; rejects anything but a `.md` name in the plans folder
#[tauri::command]
#[specta::specta]
pub async fn plan_read(app: AppHandle, name: String) -> Result<String> {
    let home = home(&app)?;
    blocking(move || plans::read(&home, &name)).await
}
