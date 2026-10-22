//! The module graph page (treeix_core::graph). Owner: G7

use super::Result;
use super::files::blocking;
use treeix_core::graph::{self, ModuleGraph};

/// Parses and resolves every git-tracked JS/TS file of the place at `root`; seconds on a large repo
#[tauri::command]
#[specta::specta]
pub async fn graph_scan(root: String) -> Result<ModuleGraph> {
    blocking(move || graph::scan(std::path::Path::new(&root))).await
}
