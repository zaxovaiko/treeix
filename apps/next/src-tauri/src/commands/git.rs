//! Git commands over treeix_core::git, each on a blocking thread since every one runs git subprocesses.

use super::Result;
use tauri::ipc::Channel;
use treeix_core::git::{
    self, Branch, Commit, DiffScope, FilePatch, GitStatus, NewWorktree, Worktree, WorktreeStep,
};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Main checkout first, then linked worktrees, missing ones included
#[tauri::command]
#[specta::specta]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>> {
    blocking(move || git::list_worktrees(&repo_path)).await
}

/// None when `path` is not inside a git checkout
#[tauri::command]
#[specta::specta]
pub async fn git_status(path: String) -> Result<Option<GitStatus>> {
    blocking(move || git::git_status(&path)).await
}

#[tauri::command]
#[specta::specta]
pub async fn diff(path: String, scope: DiffScope) -> Result<Vec<FilePatch>> {
    blocking(move || git::diff(&path, scope)).await
}

/// The file at a revision (`HEAD`, `origin/main`, a sha); None when it has no such file or it is binary
#[tauri::command]
#[specta::specta]
pub async fn read_file_at(root: String, file: String, rev: String) -> Result<Option<String>> {
    blocking(move || git::read_file_at(&root, &file, &rev)).await
}

/// Commits that touched the file, newest first, following renames
#[tauri::command]
#[specta::specta]
pub async fn file_log(root: String, file: String) -> Result<Vec<Commit>> {
    blocking(move || git::file_log(&root, &file)).await
}

/// What one commit changed, limited to `file` when set
#[tauri::command]
#[specta::specta]
pub async fn commit_diff(
    root: String,
    sha: String,
    file: Option<String>,
) -> Result<Vec<FilePatch>> {
    blocking(move || git::commit_diff(&root, &sha, file.as_deref())).await
}

/// Local branches plus remote-only ones, newest commit first
#[tauri::command]
#[specta::specta]
pub async fn list_branches(repo_path: String) -> Result<Vec<Branch>> {
    blocking(move || git::list_branches(&repo_path)).await
}

/// `git check-ref-format --branch`
#[tauri::command]
#[specta::specta]
pub async fn check_branch_name(name: String) -> Result<bool> {
    blocking(move || Ok(git::check_branch_name(&name))).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_branch(repo_path: String, name: String, base: String) -> Result<()> {
    blocking(move || git::create_branch(&repo_path, &name, &base)).await
}

/// Safe delete unless `force` (squash-merged branches need it)
#[tauri::command]
#[specta::specta]
pub async fn delete_branch(repo_path: String, name: String, force: bool) -> Result<()> {
    blocking(move || git::delete_branch(&repo_path, &name, force)).await
}

/// Sends each step's progress on `on_step`, resolves with the worktree path. Idempotent per branch / PR, so Retry calls it again
#[tauri::command]
#[specta::specta]
pub async fn add_worktree(request: NewWorktree, on_step: Channel<WorktreeStep>) -> Result<String> {
    blocking(move || {
        git::add_worktree(&request, |step| {
            // A closed dialog stops listening; the worktree is still created
            let _ = on_step.send(step);
        })
    })
    .await
}

/// Refuses the main checkout. `delete_branch` force-deletes its branch afterwards
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree(path: String, force: bool, delete_branch: bool) -> Result<()> {
    blocking(move || git::remove_worktree(&path, force, delete_branch)).await
}

/// `git worktree prune`: forgets worktrees whose folder is gone
#[tauri::command]
#[specta::specta]
pub async fn prune_worktrees(repo_path: String) -> Result<()> {
    blocking(move || git::prune_worktrees(&repo_path)).await
}

/// Restores a tracked file to HEAD, deletes an untracked one
#[tauri::command]
#[specta::specta]
pub async fn discard_changes(root: String, file: String) -> Result<()> {
    blocking(move || git::discard_changes(&root, &file)).await
}
