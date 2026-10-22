//! The folders an agent started in a place loads besides it. Port of the Electron app's projects.ts.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// What tells a project with its own agent setup apart from any other folder
const MARKERS: [&str; 5] = [".claude", ".codex", ".rulesync", "CLAUDE.md", "AGENTS.md"];

/// The projects right under a folder that holds several repos, each with its own instructions, skills and subagents
pub fn child_projects(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .map(|entry| entry.path())
        .filter(|child| MARKERS.iter().any(|marker| child.join(marker).exists()))
        .collect()
}

/// The extra folders a checkout's Claude settings name (permissions.additionalDirectories), absolute against the checkout
fn settings_directories(checkout: &Path, home: &Path) -> Vec<PathBuf> {
    ["settings.json", "settings.local.json"]
        .into_iter()
        .filter_map(|name| fs::read_to_string(checkout.join(".claude").join(name)).ok())
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .flat_map(|settings| {
            let listed = settings
                .pointer("/permissions/additionalDirectories")
                .and_then(|list| list.as_array())
                .filter(|list| list.iter().all(|entry| entry.is_string()))
                .cloned()
                .unwrap_or_default();
            listed
                .into_iter()
                .filter_map(|entry| entry.as_str().map(str::to_owned))
        })
        .map(|entry| match entry.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => normalize(&checkout.join(entry)),
        })
        .collect()
}

/// `..` resolved without touching the disk, like Node's `path.resolve`
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The main checkout a linked worktree belongs to, or None for a main checkout or a folder outside git
pub fn main_checkout_of(folder: &Path) -> Option<PathBuf> {
    let out = super::git(
        folder,
        [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
        ],
    )
    .ok()?;
    let mut lines = out.lines();
    let main = Path::new(lines.next()?).parent()?.to_path_buf();
    let top = Path::new(lines.next()?);
    (main != top).then_some(main)
}

/// What an agent started in `cwd` loads besides it: the projects under it, and in a linked worktree the folders its repo's Claude settings add.
/// Claude resolves those relative to the cwd, which from .claude/worktrees/<branch> points nowhere, so they are made absolute against the main checkout
pub fn agent_directories(cwd: &Path, home: &Path) -> Vec<PathBuf> {
    let checkout = main_checkout_of(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let added = settings_directories(&checkout, home)
        .into_iter()
        .filter(|dir| dir.exists());
    let mut seen = HashSet::new();
    child_projects(cwd)
        .into_iter()
        .chain(added)
        .filter(|dir| seen.insert(dir.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn finds_the_repos_under_a_folder_that_have_their_own_agent_setup() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("web/.claude/agents")).unwrap();
        fs::create_dir(root.join("api")).unwrap();
        fs::write(root.join("api/AGENTS.md"), "").unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("node_modules/x/.claude")).unwrap();
        fs::create_dir_all(root.join(".hidden/.claude")).unwrap();
        let mut found = child_projects(root);
        found.sort();
        assert_eq!(found, vec![root.join("api"), root.join("web")]);
        assert!(child_projects(&root.join("missing")).is_empty());
    }

    #[test]
    fn a_checkout_and_its_worktrees_load_the_folders_the_repos_claude_settings_add() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let repo = root.join("betfeel");
        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::create_dir(root.join("openora")).unwrap();
        fs::create_dir(root.join("infra")).unwrap();
        fs::write(
            repo.join(".claude/settings.json"),
            r#"{"permissions":{"additionalDirectories":["../openora","../gone"]}}"#,
        )
        .unwrap();
        fs::write(
            repo.join(".claude/settings.local.json"),
            format!(
                r#"{{"permissions":{{"additionalDirectories":["{}"]}}}}"#,
                root.join("infra").display()
            ),
        )
        .unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args([
                    "-c",
                    "user.name=T",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["add", ".claude/settings.json"]);
        git(&["commit", "-q", "-m", "init"]);
        let worktree = repo.join(".claude/worktrees/bf-1");
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "bf-1",
            worktree.to_str().unwrap(),
        ]);
        let sorted = |mut dirs: Vec<PathBuf>| {
            dirs.sort();
            dirs
        };
        let expected = vec![root.join("infra"), root.join("openora")];
        assert_eq!(sorted(agent_directories(&worktree, &root)), expected);
        assert_eq!(sorted(agent_directories(&repo, &root)), expected);
    }
}
