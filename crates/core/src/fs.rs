//! Files inside a place: listing, reading, saving with conflict check, create / rename / trash, watching. Port of the Electron app's files.ts and paths.ts.
//! Every function takes the place root and a relative path, and refuses paths that resolve outside the root.

use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Larger files read as None, like binary ones
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// The error message `save_file` fails with when the file on disk no longer matches `expected`
pub const SAVE_CONFLICT: &str = "SAVE_CONFLICT";

/// Every file in a place, for the Explorer and quick open
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaceFiles {
    /// Relative paths, `.gitignore` respected
    pub files: Vec<String>,
    /// Ignored paths; folders end with `/` and are not expanded
    pub ignored: Vec<String>,
}

/// A debounced change under a watched root
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// Relative paths that changed, `.git` excluded
    pub paths: Vec<String>,
    /// Something under `.git` changed (commit, checkout, index): git status is stale
    pub git: bool,
}

/// Absolute path of `file` inside `root`; refuses the root itself and anything that escapes it, through `..` or a symlink
pub fn inside_root(root: &Path, file: &str) -> Result<PathBuf, String> {
    let outside = || format!("{file} is outside the worktree");
    let mut parts = Vec::new();
    for component in Path::new(file).components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop().ok_or_else(outside)?;
            }
            Component::RootDir | Component::Prefix(_) => return Err(outside()),
        }
    }
    if parts.is_empty() {
        let name = if file.is_empty() {
            "An empty name"
        } else {
            file
        };
        return Err(format!(
            "{name} is the worktree itself, name something inside it"
        ));
    }
    let absolute: PathBuf = parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    // The deepest part that exists decides where symlinks lead; the rest is created under it
    let real_root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if let Some(real) = absolute
        .ancestors()
        .find_map(|path| fs::canonicalize(path).ok())
        && !real.starts_with(&real_root)
    {
        return Err(outside());
    }
    Ok(absolute)
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    (!rel.as_os_str().is_empty()).then(|| rel.to_string_lossy().into_owned())
}

/// The place's files with `.gitignore` respected (in plain folders too), and the ignored entries next to them unexpanded
pub fn list_files(root: &Path) -> Option<PlaceFiles> {
    if !root.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut dirs = vec![root.to_path_buf()];
    let walk = WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();
    for entry in walk.flatten() {
        let path = entry.path();
        let Some(rel) = relative(root, path) else {
            continue;
        };
        seen.insert(path.to_path_buf());
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            dirs.push(path.to_path_buf());
        } else {
            files.push(rel);
        }
    }
    // Whatever a walked folder holds that the walk skipped is ignored
    let mut ignored = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name() == ".git" || seen.contains(&path) {
                continue;
            }
            let Some(rel) = relative(root, &path) else {
                continue;
            };
            let folder = entry.file_type().is_ok_and(|kind| kind.is_dir());
            ignored.push(if folder { format!("{rel}/") } else { rel });
        }
    }
    files.sort();
    ignored.sort();
    Some(PlaceFiles { files, ignored })
}

/// One level of a folder, relative to `root`, folders ending in `/`; empty when it can't be read
pub fn list_directory(root: &Path, folder: &str) -> Result<Vec<String>, String> {
    let dir = if folder.is_empty() {
        root.to_path_buf()
    } else {
        inside_root(root, folder)?
    };
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{}/", folder.trim_end_matches('/'))
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_name() != ".DS_Store")
        .map(|entry| {
            let slash = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                "/"
            } else {
                ""
            };
            format!("{prefix}{}{slash}", entry.file_name().to_string_lossy())
        })
        .collect();
    names.sort();
    Ok(names)
}

/// The file as text; None when it is binary (a NUL in the first 8 KB, or not UTF-8) or over 2 MB
pub fn read_file(root: &Path, file: &str) -> Result<Option<String>, String> {
    let absolute = inside_root(root, file)?;
    let size = fs::metadata(&absolute)
        .map_err(|e| format!("{file}: {e}"))?
        .len();
    if size > MAX_READ_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&absolute).map_err(|e| format!("{file}: {e}"))?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

/// Writes only while the file still holds `expected` (what the editor loaded), so an agent's edit is never silently
/// overwritten; None skips the check. `before_write` runs once the check passed (the history snapshot)
pub fn save_file(
    root: &Path,
    file: &str,
    contents: &str,
    expected: Option<&str>,
    before_write: impl FnOnce(),
) -> Result<(), String> {
    let absolute = inside_root(root, file)?;
    if let Some(expected) = expected
        && fs::read_to_string(&absolute).ok().as_deref() != Some(expected)
    {
        return Err(SAVE_CONFLICT.into());
    }
    before_write();
    fs::write(&absolute, contents).map_err(|e| format!("{file}: {e}"))
}

/// New empty file, or folder for a path ending in `/`, creating missing parents
pub fn create_path(root: &Path, file: &str) -> Result<(), String> {
    let absolute = inside_root(root, file)?;
    if absolute.symlink_metadata().is_ok() {
        return Err(format!("{file} already exists"));
    }
    let failed = |e: std::io::Error| format!("{file}: {e}");
    if file.ends_with('/') {
        return fs::create_dir_all(&absolute).map_err(failed);
    }
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(failed)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&absolute)
        .map(drop)
        .map_err(failed)
}

pub fn rename_path(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let target = inside_root(root, to)?;
    let source = inside_root(root, from)?;
    if target.symlink_metadata().is_ok() {
        return Err(format!("{to} already exists"));
    }
    let failed = |e: std::io::Error| format!("{from}: {e}");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(failed)?;
    }
    fs::rename(source, target).map_err(failed)
}

/// Moves to the system Trash rather than deleting, so a wrong click is recoverable
pub fn trash_path(root: &Path, file: &str) -> Result<(), String> {
    trash::delete(inside_root(root, file)?).map_err(|e| format!("{file}: {e}"))
}

/// A live watch; dropping it stops the events. No file id cache: on macOS it walks and stats the whole tree,
/// `node_modules` and symlinks included, on every watch (seconds and a path per file), only to pair up renames
pub type Watch = Debouncer<RecommendedWatcher, NoCache>;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);

/// Calls `on_change` with debounced changes under `root`, or to `file` alone. A file is watched through its folder,
/// so an editor or agent replacing it by rename is still seen. A place watch also covers its git dir (a linked
/// worktree keeps it outside the root) and leaves out what happens inside ignored folders (`target/`, `node_modules/`)
pub fn watch(
    root: &Path,
    file: Option<&str>,
    on_change: impl Fn(FsChange) + Send + 'static,
) -> Result<Watch, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let target = file.map(|file| inside_root(&root, file)).transpose()?;
    let git_dirs = if target.is_none() {
        git_dirs(&root)
    } else {
        Vec::new()
    };
    let ignore = gitignore(&root);
    let handler_root = root.clone();
    let handler_target = target.clone();
    let handler_git_dirs = git_dirs.clone();
    let handler = move |result: DebounceEventResult| {
        let Ok(events) = result else {
            return;
        };
        let mut change = FsChange {
            paths: Vec::new(),
            git: false,
        };
        for path in events.iter().flat_map(|event| &event.paths) {
            if handler_git_dirs.iter().any(|dir| path.starts_with(dir)) {
                change.git = true;
                continue;
            }
            if handler_target.as_ref().is_some_and(|target| target != path) {
                continue;
            }
            let Some(rel) = relative(&handler_root, path) else {
                continue;
            };
            let in_ignored = Path::new(&rel)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .is_some_and(|parent| ignore.matched_path_or_any_parents(parent, true).is_ignore());
            if !in_ignored && !change.paths.contains(&rel) {
                change.paths.push(rel);
            }
        }
        if change.git || !change.paths.is_empty() {
            on_change(change);
        }
    };
    let mut debouncer = new_debouncer_opt(
        WATCH_DEBOUNCE,
        None,
        handler,
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    let watched = match &target {
        Some(target) => target.parent().unwrap_or(&root).to_path_buf(),
        None => root.clone(),
    };
    let mode = if target.is_some() {
        RecursiveMode::NonRecursive
    } else {
        RecursiveMode::Recursive
    };
    debouncer.watch(&watched, mode).map_err(|e| e.to_string())?;
    for dir in git_dirs.iter().filter(|dir| !dir.starts_with(&root)) {
        // ponytail: a linked worktree's index and HEAD only; a branch moved elsewhere (refs in the common dir) is not seen
        debouncer
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }
    Ok(debouncer)
}

/// `root/.git`, or the folder a linked worktree's `.git` file points at
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let dot_git = root.join(".git");
    let Ok(pointer) = fs::read_to_string(&dot_git) else {
        return vec![dot_git];
    };
    pointer
        .trim()
        .strip_prefix("gitdir: ")
        .and_then(|dir| fs::canonicalize(root.join(dir)).ok())
        .into_iter()
        .chain([dot_git])
        .collect()
}

fn gitignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    builder.add(root.join(".gitignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_root_rejects_paths_that_leave_the_worktree() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        assert_eq!(
            inside_root(root, "src/a.ts").unwrap(),
            root.join("src/a.ts")
        );
        assert!(inside_root(root, "../other/a.ts").is_err());
        assert!(inside_root(root, "/etc/passwd").is_err());
        assert!(inside_root(root, "").is_err());
        assert!(inside_root(root, "src/..").is_err());
        assert_eq!(inside_root(root, "src/../b").unwrap(), root.join("b"));
    }

    #[cfg(unix)]
    #[test]
    fn inside_root_follows_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(inside_root(root.path(), "link/secret").is_err());
    }

    #[test]
    fn save_file_refuses_to_overwrite_a_file_that_changed_since_it_was_loaded() {
        let root = tempfile::tempdir().unwrap();
        let (root, path) = (root.path(), root.path().join("a.ts"));
        fs::write(&path, "loaded").unwrap();
        save_file(root, "a.ts", "mine", Some("loaded"), || {}).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        fs::write(&path, "agent edit").unwrap();
        let err = save_file(root, "a.ts", "mine again", Some("mine"), || {}).unwrap_err();
        assert!(err.contains(SAVE_CONFLICT));
        assert_eq!(fs::read_to_string(&path).unwrap(), "agent edit");
        save_file(root, "a.ts", "forced", None, || {}).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "forced");
    }

    #[test]
    fn list_files_respects_gitignore_without_git() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::write(root.join(".gitignore"), "dist/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("dist/deep")).unwrap();
        fs::write(root.join("dist/deep/x.js"), "").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/debug.log"), "").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();
        let listed = list_files(root).unwrap();
        assert_eq!(listed.files, [".gitignore", "src/a.ts"]);
        assert_eq!(listed.ignored, ["dist/", "src/debug.log"]);
        assert_eq!(list_files(&root.join("gone")), None);
    }

    #[test]
    fn list_directory_marks_folders() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::create_dir_all(root.join("src/lib")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/.DS_Store"), "").unwrap();
        assert_eq!(list_directory(root, "").unwrap(), ["src/"]);
        assert_eq!(
            list_directory(root, "src").unwrap(),
            ["src/a.ts", "src/lib/"]
        );
        assert!(list_directory(root, "../x").is_err());
    }

    #[test]
    fn read_file_skips_binary_and_large_files() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::write(root.join("a.txt"), "hi").unwrap();
        fs::write(root.join("b.bin"), [1, 0, 2]).unwrap();
        fs::write(
            root.join("big.txt"),
            vec![b'x'; MAX_READ_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(read_file(root, "a.txt").unwrap().as_deref(), Some("hi"));
        assert_eq!(read_file(root, "b.bin").unwrap(), None);
        assert_eq!(read_file(root, "big.txt").unwrap(), None);
        assert!(read_file(root, "missing").is_err());
    }

    #[test]
    fn create_and_rename_refuse_existing_paths() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        create_path(root, "a/b/c.ts").unwrap();
        create_path(root, "d/e/").unwrap();
        assert!(root.join("d/e").is_dir());
        assert!(create_path(root, "a/b/c.ts").is_err());
        rename_path(root, "a/b/c.ts", "x/y.ts").unwrap();
        assert!(root.join("x/y.ts").is_file());
        create_path(root, "z.ts").unwrap();
        assert!(rename_path(root, "z.ts", "x/y.ts").is_err());
        assert!(rename_path(root, "z.ts", "../z.ts").is_err());
    }

    #[test]
    fn watch_reports_relative_paths_and_git_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _watch = watch(root, None, move |change| tx.send(change).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        fs::write(root.join("target/out.o"), "x").unwrap();
        fs::write(root.join("a.ts"), "x").unwrap();
        fs::write(root.join(".git/index"), "x").unwrap();
        let mut paths = Vec::new();
        let mut git = false;
        while let Ok(change) = rx.recv_timeout(Duration::from_secs(2)) {
            paths.extend(change.paths);
            git |= change.git;
        }
        assert!(git);
        assert!(paths.contains(&"a.ts".to_string()), "{paths:?}");
        assert!(
            !paths
                .iter()
                .any(|path| path.starts_with("target/") || path.starts_with(".git")),
            "{paths:?}"
        );
    }

    #[test]
    fn watch_file_sees_only_that_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.ts"), "x").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _watch = watch(root, Some("a.ts"), move |change| tx.send(change).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        fs::write(root.join("b.ts"), "x").unwrap();
        fs::write(root.join("a.ts.tmp"), "y").unwrap();
        fs::rename(root.join("a.ts.tmp"), root.join("a.ts")).unwrap();
        let change = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(change.paths, ["a.ts"]);
    }
}
