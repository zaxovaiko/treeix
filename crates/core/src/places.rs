//! Where a session runs: the git checkout (root, linked worktree, detached) or plain folder behind a cwd.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PlaceKind {
    Root,
    Worktree,
    Git,
    Folder,
    Scratch,
    Detached,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub key: String,
    pub kind: PlaceKind,
    pub name: String,
    pub path: String,
    pub repo_root: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub missing: bool,
}

/// Resolves every path on its own thread; each costs one `git` process
pub fn resolve_all(paths: &[String], home: &Path) -> Vec<Place> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .iter()
            .map(|path| scope.spawn(move || resolve(Path::new(path), home)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("place resolver panicked"))
            .collect()
    })
}

pub fn resolve(path: &Path, home: &Path) -> Place {
    let shown = path.to_string_lossy().into_owned();
    let Ok(real) = fs::canonicalize(path) else {
        return folder(shown.clone(), shown, true);
    };
    if fs::canonicalize(home).is_ok_and(|home| home == real) {
        return Place {
            kind: PlaceKind::Scratch,
            name: "~".into(),
            ..folder(lossy(&real), shown, false)
        };
    }
    let Some(checkout) = Checkout::of(&real) else {
        return folder(lossy(&real), shown, false);
    };
    let repo_root = checkout
        .common_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| checkout.top.clone());
    let head = fs::read_to_string(checkout.git_dir.join("HEAD")).unwrap_or_default();
    let branch = head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_owned);
    let linked = checkout.git_dir != checkout.common_dir;
    let kind = match (&branch, linked) {
        (None, _) => PlaceKind::Detached,
        (Some(_), true) => PlaceKind::Worktree,
        (Some(_), false) if has_remote(&checkout.common_dir) => PlaceKind::Root,
        (Some(_), false) => PlaceKind::Git,
    };
    let name = match (kind, &branch) {
        (PlaceKind::Root | PlaceKind::Worktree, Some(branch)) => branch.clone(),
        _ => file_name(&checkout.top),
    };
    Place {
        key: lossy(&checkout.top),
        kind,
        name,
        path: shown,
        repo_name: Some(file_name(&repo_root)),
        repo_root: Some(lossy(&repo_root)),
        head: branch
            .is_none()
            .then(|| head.trim().chars().take(7).collect()),
        branch,
        missing: false,
    }
}

struct Checkout {
    top: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

impl Checkout {
    /// HEAD is read from the git dir rather than `rev-parse HEAD`, which fails in a repo without commits
    fn of(dir: &Path) -> Option<Self> {
        let out = Command::new("git")
            .args(["--no-optional-locks", "-C"])
            .arg(dir)
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-dir",
                "--git-common-dir",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let stdout = String::from_utf8(out.stdout).ok()?;
        let mut lines = stdout.lines().map(PathBuf::from);
        Some(Self {
            top: lines.next()?,
            git_dir: lines.next()?,
            common_dir: lines.next()?,
        })
    }
}

fn has_remote(common_dir: &Path) -> bool {
    fs::read_to_string(common_dir.join("config")).is_ok_and(|config| config.contains("[remote \""))
}

fn folder(key: String, path: String, missing: bool) -> Place {
    Place {
        name: file_name(Path::new(&key)),
        key,
        kind: PlaceKind::Folder,
        path,
        repo_root: None,
        repo_name: None,
        branch: None,
        head: None,
        missing,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| lossy(path), |name| name.to_string_lossy().into_owned())
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    fn repo(base: &Path) -> PathBuf {
        let main = fs::canonicalize(base).unwrap().join("repo");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        main
    }

    #[test]
    fn plain_folder_and_missing_and_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir(&home).unwrap();
        let place = resolve(tmp.path(), &home);
        assert_eq!(
            (place.kind, place.missing, place.repo_root),
            (PlaceKind::Folder, false, None)
        );
        let gone = resolve(&tmp.path().join("gone"), &home);
        assert_eq!((gone.kind, gone.missing), (PlaceKind::Folder, true));
        let scratch = resolve(&home, &home);
        assert_eq!(
            (scratch.kind, scratch.name.as_str()),
            (PlaceKind::Scratch, "~")
        );
    }

    #[test]
    fn git_without_remote_then_root_with_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let main = repo(tmp.path());
        let sub = main.join("src");
        fs::create_dir(&sub).unwrap();
        let place = resolve(&sub, Path::new("/nonexistent"));
        assert_eq!(place.kind, PlaceKind::Git);
        assert_eq!(place.key, lossy(&main));
        assert_eq!(place.name, "repo");
        assert_eq!(place.branch.as_deref(), Some("main"));
        assert_eq!(place.repo_root.as_deref(), Some(lossy(&main).as_str()));

        git(
            &main,
            &["remote", "add", "origin", "https://example.com/r.git"],
        );
        let place = resolve(&main, Path::new("/nonexistent"));
        assert_eq!((place.kind, place.name.as_str()), (PlaceKind::Root, "main"));
    }

    #[test]
    fn linked_worktree_and_detached() {
        let tmp = tempfile::tempdir().unwrap();
        let main = repo(tmp.path());
        let wt = main.parent().unwrap().join("wt");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/x",
                wt.to_str().unwrap(),
            ],
        );
        let place = resolve(&wt, Path::new("/nonexistent"));
        assert_eq!(place.kind, PlaceKind::Worktree);
        assert_eq!(place.key, lossy(&wt));
        assert_eq!(place.name, "feat/x");
        assert_eq!(place.repo_root.as_deref(), Some(lossy(&main).as_str()));
        assert_eq!(place.repo_name.as_deref(), Some("repo"));

        git(&wt, &["checkout", "-q", "--detach"]);
        let place = resolve(&wt, Path::new("/nonexistent"));
        assert_eq!((place.kind, place.branch), (PlaceKind::Detached, None));
        assert_eq!(place.head.map(|h| h.len()), Some(7));
        assert_eq!(place.repo_root.as_deref(), Some(lossy(&main).as_str()));
    }

    #[test]
    fn repo_without_commits_is_git() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        git(&dir, &["init", "-q"]);
        let place = resolve(&dir, Path::new("/nonexistent"));
        assert_eq!(
            (place.kind, place.branch.as_deref()),
            (PlaceKind::Git, Some("main"))
        );
    }

    #[test]
    fn serializes_camel_case() {
        let json =
            serde_json::to_value(resolve(Path::new("/definitely/gone"), Path::new("/"))).unwrap();
        assert_eq!(json["kind"], "folder");
        assert_eq!(json["repoRoot"], serde_json::Value::Null);
        assert_eq!(json["missing"], true);
    }
}
