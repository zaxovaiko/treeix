//! Pull request commands over treeix_core::prs (gh / glab).

use super::Result;
use super::files::blocking;
use treeix_core::prs::{self, Check, MergeMethod, PrRef, ProviderStatus, PullRequestList};

/// Open PRs plus recently merged / closed ones of every repo; a repo that fails lands in `errors`, not the whole call
#[tauri::command]
#[specta::specta]
pub async fn list_pull_requests(repo_paths: Vec<String>) -> Result<PullRequestList> {
    blocking(move || Ok(prs::list_pull_requests(&repo_paths))).await
}

/// The head commit's checks (GitHub) or pipeline jobs (GitLab)
#[tauri::command]
#[specta::specta]
pub async fn pr_checks(pr: PrRef) -> Result<Vec<Check>> {
    blocking(move || prs::pr_checks(&pr)).await
}

#[tauri::command]
#[specta::specta]
pub async fn merge_pull_request(pr: PrRef, method: MergeMethod, delete_branch: bool) -> Result<()> {
    blocking(move || prs::merge_pull_request(&pr, method, delete_branch)).await
}

/// gh and glab: installed, signed in, as whom
#[tauri::command]
#[specta::specta]
pub async fn pr_providers() -> Result<Vec<ProviderStatus>> {
    blocking(|| Ok(prs::pr_providers())).await
}
