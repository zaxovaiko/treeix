//! Git over `git --no-optional-locks` subprocesses: worktrees, status, diffs, branches, file log. Port of the Electron app's git.ts.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};

pub mod projects;

/// One `git worktree list --porcelain` entry
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// Short sha; empty in a repo with no commits yet
    pub head: String,
    /// None when detached
    pub branch: Option<String>,
    /// The repo's main checkout
    pub main: bool,
    /// Folder is gone; `prune_worktrees` drops it
    pub missing: bool,
}

/// A file's state, from `git status` or a diff
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// One uncommitted file
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub status: ChangeStatus,
    /// Source of a rename
    pub old_path: Option<String>,
}

/// An interrupted rebase: `step` of `total` commits applied
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Rebase {
    pub step: u32,
    pub total: u32,
}

/// Everything the Changes panel, the sidebar badges and the Cleanup dialog show about one checkout
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// None when detached
    pub branch: Option<String>,
    /// Short sha; None before the first commit
    pub head: Option<String>,
    /// Like `origin/feat/x`; None when the branch was never pushed
    pub upstream: Option<String>,
    /// Commits not pushed to / not pulled from the upstream
    pub ahead: u32,
    pub behind: u32,
    /// The upstream was deleted, typically after its PR merged
    pub gone: bool,
    /// The repo's default branch, like `main`; None without one
    pub base: Option<String>,
    /// Commits on this branch that are not in `origin/<base>` (or `<base>`)
    pub base_ahead: u32,
    /// Branch has commits and all of them are in the base (or the upstream is gone)
    pub merged: bool,
    pub rebase: Option<Rebase>,
    /// Paths with unresolved conflicts
    pub conflicts: Vec<String>,
    /// Uncommitted changes, untracked files included
    pub changes: Vec<Change>,
}

/// What `diff` compares the working tree against
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    /// Uncommitted: HEAD vs the working tree, untracked files as additions
    Local,
    /// What the PR shows: the merge base with the base branch vs the working tree
    Base,
}

/// One file's unified diff
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilePatch {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    /// `diff --git` text with headers; empty for binary files
    pub patch: String,
    pub additions: u32,
    pub deletions: u32,
}

/// A local branch, or a remote-only one
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Remote-only branches are named like `origin/feat/x`
    pub name: String,
    pub remote: bool,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub merged: bool,
    /// Unix seconds of the last commit
    pub committed_at: i64,
    /// Author of the last commit
    pub author: String,
    /// Worktree that has it checked out
    pub worktree: Option<String>,
}

/// One commit from `git log`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub author: String,
    /// Unix seconds
    pub date: i64,
    pub subject: String,
}

/// What the Open worktree dialog asks for. Exactly one of `branch` or `pr` is set
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    pub repo_path: String,
    /// Checked out if it exists locally, tracks `origin/<branch>` if only there, otherwise created from `base`
    pub branch: Option<String>,
    /// Start point for a new branch; default `origin/<default branch>`
    pub base: Option<String>,
    /// PR/MR number: fetches its head and adds a detached `pr-N` / `mr-N` worktree
    pub pr: Option<u32>,
    /// Copy the main checkout's `.env` and `.env.*` files
    pub copy_env: bool,
    /// Shell command run in the new worktree, like `bun install`
    pub setup: Option<String>,
    /// "Continue without fetching" after a failed fetch; ignored for PRs
    pub skip_fetch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StepId {
    Fetch,
    Add,
    Env,
    Setup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Running,
    Done,
    Failed,
    Skipped,
}

/// Progress of one worktree creation step
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStep {
    pub step: StepId,
    pub state: StepState,
    /// The command line shown next to the step
    pub command: String,
    /// stderr (or the tail of the output) when failed
    pub error: Option<String>,
}

const MAX_UNTRACKED_PATCHES: usize = 200;
/// What `diff` compares against before the first commit
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SETUP_ERROR_LINES: usize = 30;

type Result<T> = std::result::Result<T, String>;

fn run<S: AsRef<OsStr>>(cwd: &Path, args: impl IntoIterator<Item = S>) -> Result<Output> {
    // Polling status must not take index.lock, or an agent's commit or rebase running at that moment fails on it
    Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))
}

fn git<S: AsRef<OsStr>>(cwd: &Path, args: impl IntoIterator<Item = S>) -> Result<String> {
    let out = run(cwd, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(failure(&out))
    }
}

fn failure(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    if stderr.is_empty() {
        format!("git failed ({})", out.status)
    } else {
        stderr
    }
}

fn succeeds<S: AsRef<OsStr>>(cwd: &Path, args: impl IntoIterator<Item = S>) -> bool {
    run(cwd, args).is_ok_and(|out| out.status.success())
}

fn has_ref(repo: &Path, name: &str) -> bool {
    succeeds(repo, ["show-ref", "--verify", "--quiet", name])
}

/// Arguments that git would read as options
fn refuse_option(kind: &str, value: &str) -> Result<()> {
    if value.starts_with('-') {
        Err(format!("\"{value}\" is not a valid {kind}"))
    } else {
        Ok(())
    }
}

pub fn parse_worktree_list(porcelain: &str) -> Vec<Worktree> {
    porcelain
        .split("\n\n")
        .map(str::trim)
        .enumerate()
        .filter(|(_, block)| block.starts_with("worktree ") && !block.lines().any(|l| l == "bare"))
        .map(|(index, block)| {
            let field = |key: &str| {
                block.lines().find_map(|line| {
                    line.strip_prefix(key)
                        .and_then(|rest| rest.strip_prefix(' '))
                })
            };
            let head: String = field("HEAD").unwrap_or_default().chars().take(7).collect();
            Worktree {
                path: field("worktree").unwrap_or_default().to_owned(),
                head: if head.chars().all(|c| c == '0') {
                    String::new()
                } else {
                    head
                },
                branch: field("branch").map(|b| b.trim_start_matches("refs/heads/").to_owned()),
                main: index == 0,
                missing: false,
            }
        })
        .collect()
}

pub fn list_worktrees(repo_path: &str) -> Result<Vec<Worktree>> {
    let mut worktrees = parse_worktree_list(&git(
        Path::new(repo_path),
        ["worktree", "list", "--porcelain"],
    )?);
    for worktree in &mut worktrees {
        worktree.missing = !Path::new(&worktree.path).exists();
    }
    Ok(worktrees)
}

/// Worktree folder per the `.claude/worktrees/<branch with + for />` convention
pub fn worktree_dir(repo_path: &Path, branch: &str) -> PathBuf {
    repo_path
        .join(".claude")
        .join("worktrees")
        .join(branch.replace('/', "+"))
}

const C_ESCAPES: [(char, u8); 9] = [
    ('a', 7),
    ('b', 8),
    ('t', 9),
    ('n', 10),
    ('v', 11),
    ('f', 12),
    ('r', 13),
    ('"', 34),
    ('\\', 92),
];

/// The inside of a path git quoted, which spells non-ASCII bytes in octal: `\303\251` is é
pub fn unquote_git_path(quoted: &str) -> String {
    let mut bytes = Vec::with_capacity(quoted.len());
    let mut chars = quoted.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        let Some(next) = chars.next() else { break };
        if next.is_digit(8) {
            let mut value = next.to_digit(8).unwrap_or(0);
            for _ in 0..2 {
                match chars.peek().and_then(|d| d.to_digit(8)) {
                    Some(digit) => {
                        value = value * 8 + digit;
                        chars.next();
                    }
                    None => break,
                }
            }
            bytes.push(value as u8);
        } else {
            let byte = C_ESCAPES
                .iter()
                .find(|(escape, _)| *escape == next)
                .map(|(_, byte)| *byte);
            match byte {
                Some(byte) => bytes.push(byte),
                None => {
                    let mut buf = [0; 4];
                    bytes.extend_from_slice(next.encode_utf8(&mut buf).as_bytes());
                }
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Length of a quoted string's inside when it is closed right at the end of `text`, None when another quote closes it first
fn quoted_to_end(text: &str) -> Option<usize> {
    let inner = text.strip_suffix('"')?;
    let mut escaped = false;
    for c in inner.chars() {
        match (escaped, c) {
            (true, _) => escaped = false,
            (false, '\\') => escaped = true,
            (false, '"') => return None,
            _ => {}
        }
    }
    (!escaped).then_some(inner.len())
}

/// The new path from a `diff --git a/x b/y` line; either side may be quoted
pub fn diff_path(header: &str) -> String {
    let Some(rest) = header.strip_prefix("diff --git ") else {
        return String::new();
    };
    for (index, _) in rest.match_indices(" \"b/") {
        let quoted = &rest[index + 4..];
        if let Some(len) = quoted_to_end(quoted) {
            return unquote_git_path(&quoted[..len]);
        }
    }
    let b_side = if rest.starts_with('"') {
        // Skip the quoted a side
        let mut escaped = false;
        rest.char_indices()
            .skip(1)
            .find_map(|(i, c)| match (escaped, c) {
                (true, _) => {
                    escaped = false;
                    None
                }
                (false, '\\') => {
                    escaped = true;
                    None
                }
                (false, '"') => rest[i + 1..].strip_prefix(" b/"),
                _ => None,
            })
    } else if rest.starts_with("a/") {
        rest.get(3..)
            .and_then(|after| after.find(" b/").map(|i| &after[i + 3..]))
    } else {
        None
    };
    b_side.unwrap_or_default().to_owned()
}

fn header_path(line: &str) -> String {
    match line.strip_prefix('"').and_then(|l| l.strip_suffix('"')) {
        Some(quoted) => unquote_git_path(quoted),
        None => line.to_owned(),
    }
}

pub fn split_patch(patch: &str) -> Vec<FilePatch> {
    let starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .map(|(i, _)| i)
        .filter(|&i| i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| &patch[start..starts.get(n + 1).copied().unwrap_or(patch.len())])
        .map(|chunk| {
            let hunk_start = chunk.find("\n@@");
            let headers = &chunk[..hunk_start.unwrap_or(chunk.len())];
            let hunks = hunk_start.map(|i| &chunk[i + 1..]).unwrap_or_default();
            let header = |key: &str| headers.lines().find_map(|line| line.strip_prefix(key));
            let old_path = header("rename from ").map(header_path);
            let status = if old_path.is_some() {
                ChangeStatus::Renamed
            } else if header("new file mode").is_some() {
                ChangeStatus::Added
            } else if header("deleted file mode").is_some() {
                ChangeStatus::Deleted
            } else {
                ChangeStatus::Modified
            };
            let binary = hunk_start.is_none() && header("Binary files ").is_some();
            FilePatch {
                path: diff_path(chunk.lines().next().unwrap_or_default()),
                old_path,
                status,
                patch: if binary {
                    String::new()
                } else {
                    chunk.to_owned()
                },
                additions: hunks.lines().filter(|l| l.starts_with('+')).count() as u32,
                deletions: hunks.lines().filter(|l| l.starts_with('-')).count() as u32,
            }
        })
        .collect()
}

/// `git status --porcelain=v2 --branch -z` without what needs more git calls (base, merged, rebase)
pub fn parse_status(porcelain: &str) -> GitStatus {
    let mut status = GitStatus {
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        gone: false,
        base: None,
        base_ahead: 0,
        merged: false,
        rebase: None,
        conflicts: Vec::new(),
        changes: Vec::new(),
    };
    let mut tracked = false;
    let mut records = porcelain.split('\0');
    while let Some(record) = records.next() {
        let (kind, rest) = record.split_once(' ').unwrap_or((record, ""));
        // Fields before the path: `1` has 7, `2` has 8, `u` has 9
        let path_after =
            |fields: usize| rest.splitn(fields + 1, ' ').nth(fields).map(str::to_owned);
        let xy = rest.get(..2).unwrap_or_default();
        match kind {
            "#" => match rest.split_once(' ') {
                Some(("branch.oid", oid)) if oid != "(initial)" => {
                    status.head = Some(oid.chars().take(7).collect())
                }
                Some(("branch.head", head)) if head != "(detached)" => {
                    status.branch = Some(head.to_owned())
                }
                Some(("branch.upstream", upstream)) => status.upstream = Some(upstream.to_owned()),
                Some(("branch.ab", ab)) => {
                    tracked = true;
                    let mut counts = ab
                        .split(' ')
                        .map(|n| n.trim_start_matches(['+', '-']).parse::<u32>().unwrap_or(0));
                    status.ahead = counts.next().unwrap_or(0);
                    status.behind = counts.next().unwrap_or(0);
                }
                _ => {}
            },
            "1" | "2" => {
                let Some(path) = path_after(if kind == "1" { 7 } else { 8 }) else {
                    continue;
                };
                let old_path = (kind == "2").then(|| records.next().unwrap_or_default().to_owned());
                let status_of = if old_path.is_some() {
                    ChangeStatus::Renamed
                } else if xy.contains('D') {
                    ChangeStatus::Deleted
                } else if xy.contains('A') {
                    ChangeStatus::Added
                } else {
                    ChangeStatus::Modified
                };
                status.changes.push(Change {
                    path,
                    status: status_of,
                    old_path,
                });
            }
            "u" => {
                if let Some(path) = path_after(9) {
                    status.conflicts.push(path.clone());
                    status.changes.push(Change {
                        path,
                        status: ChangeStatus::Conflicted,
                        old_path: None,
                    });
                }
            }
            "?" if !rest.is_empty() => status.changes.push(Change {
                path: rest.to_owned(),
                status: ChangeStatus::Untracked,
                old_path: None,
            }),
            _ => {}
        }
    }
    // An upstream that is configured but has no ref left was deleted on the remote
    status.gone = status.upstream.is_some() && !tracked;
    status
}

/// "ahead 2, behind 3" or "gone" from for-each-ref's upstream:track
pub fn parse_track(track: &str) -> (u32, u32, bool) {
    let count = |key: &str| {
        track
            .split(", ")
            .find_map(|part| part.strip_prefix(key))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    };
    (count("ahead "), count("behind "), track == "gone")
}

/// `origin/main` when the remote names its HEAD, else the first local main / master / dev
pub fn default_branch(repo: &Path) -> Option<String> {
    let remote_head = git(
        repo,
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .unwrap_or_default();
    let remote_head = remote_head.trim();
    if !remote_head.is_empty() {
        return Some(remote_head.to_owned());
    }
    ["main", "master", "dev"]
        .into_iter()
        .find(|candidate| has_ref(repo, &format!("refs/heads/{candidate}")))
        .map(str::to_owned)
}

/// The default branch's name and the freshest ref for it: `origin/<base>` when fetched, else the local branch
fn base_of(repo: &Path) -> Option<(String, String)> {
    let base = default_branch(repo)?;
    let name = base.strip_prefix("origin/").unwrap_or(&base).to_owned();
    let remote = format!("origin/{name}");
    let base_ref = if has_ref(repo, &format!("refs/remotes/{remote}")) {
        remote
    } else {
        name.clone()
    };
    Some((name, base_ref))
}

fn rev_parse(repo: &Path, rev: &str) -> Option<String> {
    git(repo, ["rev-parse", "--verify", "--quiet", rev])
        .ok()
        .map(|sha| sha.trim().to_owned())
}

fn rebase_progress(git_dir: &Path) -> Option<Rebase> {
    let read = |dir: &str, file: &str| {
        fs::read_to_string(git_dir.join(dir).join(file))
            .ok()?
            .trim()
            .parse::<u32>()
            .ok()
    };
    [
        ("rebase-merge", "msgnum", "end"),
        ("rebase-apply", "next", "last"),
    ]
    .into_iter()
    .find_map(|(dir, step, total)| {
        Some(Rebase {
            step: read(dir, step)?,
            total: read(dir, total)?,
        })
    })
}

/// None when `path` is not inside a git checkout
pub fn git_status(path: &str) -> Result<Option<GitStatus>> {
    let path = Path::new(path);
    let Ok(git_dir) = git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]) else {
        return Ok(None);
    };
    let mut status = parse_status(&git(
        path,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?);
    status.rebase = rebase_progress(Path::new(git_dir.trim()));
    if let Some((base, base_ref)) = base_of(path) {
        if status.head.is_some() {
            status.base_ahead = git(path, ["rev-list", "--count", &format!("{base_ref}..HEAD")])
                .ok()
                .and_then(|n| n.trim().parse().ok())
                .unwrap_or(0);
            let on_base = status.branch.as_deref() == Some(base.as_str());
            // A fresh branch still at the base tip has nothing to clean up
            let moved = rev_parse(path, "HEAD") != rev_parse(path, &base_ref);
            status.merged = status.branch.is_some()
                && !on_base
                && (status.gone || (status.base_ahead == 0 && moved));
        }
        status.base = Some(base);
    }
    Ok(Some(status))
}

/// Working tree vs `from`, untracked files as additions
fn diff_from(path: &Path, from: &str) -> Result<Vec<FilePatch>> {
    // Plumbing: porcelain diff rewrites the index, under its lock, whenever file times changed
    let tracked = git(path, ["diff-index", "-p", "-M", "--no-color", from, "--"])?;
    let untracked = git(path, ["ls-files", "--others", "--exclude-standard", "-z"])?;
    let untracked: Vec<&str> = untracked
        .split('\0')
        .filter(|f| !f.is_empty())
        .take(MAX_UNTRACKED_PATCHES)
        .collect();
    let untracked_patches: Vec<String> = std::thread::scope(|scope| {
        untracked
            .chunks(MAX_UNTRACKED_PATCHES / 8)
            .map(|files| {
                scope.spawn(move || {
                    files
                        .iter()
                        .filter_map(|file| {
                            run(
                                path,
                                ["diff", "--no-color", "--no-index", "--", "/dev/null", file],
                            )
                            .ok()
                            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });
    let mut patches: Vec<FilePatch> = split_patch(&tracked)
        .into_iter()
        // Files only touched (stat dirty) show as a bare header
        .filter(|p| p.patch.lines().count() > 1 || p.patch.is_empty())
        .collect();
    patches.extend(
        split_patch(&untracked_patches.join("\n"))
            .into_iter()
            .map(|p| FilePatch {
                status: ChangeStatus::Untracked,
                ..p
            }),
    );
    Ok(patches)
}

pub fn diff(path: &str, scope: DiffScope) -> Result<Vec<FilePatch>> {
    let path = Path::new(path);
    let head = rev_parse(path, "HEAD");
    let local = head.clone().unwrap_or_else(|| EMPTY_TREE.to_owned());
    let from = match scope {
        DiffScope::Local => local,
        DiffScope::Base => base_of(path)
            .zip(head)
            .and_then(|((_, base_ref), _)| git(path, ["merge-base", &base_ref, "HEAD"]).ok())
            .map(|sha| sha.trim().to_owned())
            .unwrap_or(local),
    };
    diff_from(path, &from)
}

/// The file at a revision; None when it has no such file or it is binary
pub fn read_file_at(root: &str, file: &str, rev: &str) -> Result<Option<String>> {
    crate::fs::inside_root(Path::new(root), file)?;
    refuse_option("revision", rev)?;
    let out = run(Path::new(root), ["show", &format!("{rev}:./{file}")])?;
    if !out.status.success() || out.stdout.contains(&0) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// Commits that touched the file, newest first, following renames
pub fn file_log(root: &str, file: &str) -> Result<Vec<Commit>> {
    crate::fs::inside_root(Path::new(root), file)?;
    let log = git(
        Path::new(root),
        [
            "log",
            "--follow",
            "--format=%H%x00%an%x00%at%x00%s",
            "--",
            file,
        ],
    )?;
    Ok(log
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\0');
            Some(Commit {
                sha: fields.next()?.to_owned(),
                author: fields.next()?.to_owned(),
                date: fields.next()?.parse().ok()?,
                subject: fields.next().unwrap_or_default().to_owned(),
            })
        })
        .collect())
}

/// What one commit changed against its first parent, limited to `file` when set
pub fn commit_diff(root: &str, sha: &str, file: Option<&str>) -> Result<Vec<FilePatch>> {
    let root = Path::new(root);
    refuse_option("commit", sha)?;
    let mut args = vec![
        "show",
        "--format=",
        "-p",
        "-M",
        "--no-color",
        "--diff-merges=first-parent",
        sha,
        "--",
    ];
    if let Some(file) = file {
        crate::fs::inside_root(root, file)?;
        args.push(file);
    }
    Ok(split_patch(&git(root, args)?))
}

const BRANCH_FORMAT: &str =
    "--format=%(refname)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(authorname)";

/// Local branches plus remote-only ones, newest commit first
pub fn list_branches(repo_path: &str) -> Result<Vec<Branch>> {
    let repo = Path::new(repo_path);
    let base = default_branch(repo);
    let refs = git(
        repo,
        [
            "for-each-ref",
            "--sort=-committerdate",
            BRANCH_FORMAT,
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let merged = base
        .as_deref()
        .and_then(|base| {
            git(
                repo,
                [
                    "for-each-ref",
                    "--merged",
                    base,
                    "--format=%(refname)",
                    "refs/heads",
                ],
            )
            .ok()
        })
        .unwrap_or_default();
    // The default branch itself is never "merged", whether base is main or origin/main
    let base_name = base.as_deref().map(|b| b.trim_start_matches("origin/"));
    let merged: HashSet<&str> = merged.lines().collect();
    let worktrees: HashMap<String, String> = list_worktrees(repo_path)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| Some((w.branch?, w.path)))
        .collect();
    let rows: Vec<Vec<&str>> = refs.lines().map(|row| row.split('\0').collect()).collect();
    let local: HashSet<&str> = rows
        .iter()
        .filter_map(|row| row[0].strip_prefix("refs/heads/"))
        .collect();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let field = |n: usize| row.get(n).copied().unwrap_or_default();
            let refname = field(0);
            let (name, remote) = match refname.strip_prefix("refs/remotes/") {
                Some(name) => (name, true),
                None => (refname.strip_prefix("refs/heads/")?, false),
            };
            let short = name.split_once('/').map_or(name, |(_, short)| short);
            // origin/HEAD is an alias, and remote branches that also exist locally would show twice
            if remote && (name.ends_with("/HEAD") || local.contains(short)) {
                return None;
            }
            let (ahead, behind, gone) = parse_track(field(1));
            Some(Branch {
                name: name.to_owned(),
                remote,
                ahead,
                behind,
                gone,
                merged: !remote && merged.contains(refname) && Some(name) != base_name,
                committed_at: field(2).parse().unwrap_or(0),
                author: field(3).to_owned(),
                worktree: (!remote).then(|| worktrees.get(name).cloned()).flatten(),
            })
        })
        .collect())
}

/// `git check-ref-format --branch`
pub fn check_branch_name(name: &str) -> bool {
    !name.starts_with('-') && branch_name(&std::env::temp_dir(), name).is_ok()
}

/// The branch name as git normalizes it; fails for one git would reject
fn branch_name(repo: &Path, name: &str) -> Result<String> {
    let checked = git(repo, ["check-ref-format", "--branch", name]).unwrap_or_default();
    let checked = checked.trim();
    if checked.is_empty() || checked.starts_with('-') {
        return Err(format!("\"{name}\" is not a valid branch name"));
    }
    Ok(checked.to_owned())
}

pub fn create_branch(repo_path: &str, name: &str, base: &str) -> Result<()> {
    let repo = Path::new(repo_path);
    let name = branch_name(repo, name)?;
    refuse_option("base", base)?;
    git(repo, ["branch", "--no-track", &name, base]).map(drop)
}

/// Safe delete unless `force` (squash-merged branches need it)
pub fn delete_branch(repo_path: &str, name: &str, force: bool) -> Result<()> {
    refuse_option("branch name", name)?;
    git(
        Path::new(repo_path),
        ["branch", if force { "-D" } else { "-d" }, name],
    )
    .map(drop)
}

/// The default branch's name and the subjects of the commits on HEAD it lacks, oldest first
pub fn commits_ahead(path: &str) -> Result<(String, Vec<String>)> {
    let path = Path::new(path);
    let (name, base) = base_of(path).ok_or("The repository has no main, master or dev branch")?;
    let log = git(
        path,
        ["log", "--reverse", "--format=%s", &format!("{base}..HEAD")],
    )?;
    Ok((name, log.lines().map(str::to_owned).collect()))
}

/// Fast-forwards HEAD (a branch or detached) to `branch` on origin
pub fn catch_up(path: &str, branch: &str) -> Result<()> {
    refuse_option("branch name", branch)?;
    let path = Path::new(path);
    git(path, ["fetch", "origin", branch])?;
    git(path, ["merge", "--ff-only", "FETCH_HEAD"]).map(drop)
}

/// Commits every change, untracked files too
pub fn commit_all(path: &str, message: &str) -> Result<()> {
    let path = Path::new(path);
    git(path, ["add", "--all"])?;
    git(path, ["commit", "--quiet", "--message", message]).map(drop)
}

/// Pushes HEAD to `branch` on origin
pub fn push(path: &str, branch: &str) -> Result<()> {
    refuse_option("branch name", branch)?;
    git(
        Path::new(path),
        ["push", "origin", &format!("HEAD:refs/heads/{branch}")],
    )
    .map(drop)
}

/// Creations in flight, by repository and branch or PR: a second call joins the first
type InFlight = Arc<OnceLock<Result<String>>>;
static ADDING: LazyLock<Mutex<HashMap<String, InFlight>>> = LazyLock::new(Default::default);

/// Creates (or reuses) the worktree for a branch or PR, reporting each step; resolves with its path
pub fn add_worktree(request: &NewWorktree, on_step: impl FnMut(WorktreeStep)) -> Result<String> {
    let key = format!(
        "{}\0{:?}\0{:?}",
        request.repo_path, request.branch, request.pr
    );
    let (cell, joined) = {
        let mut adding = ADDING.lock().unwrap_or_else(PoisonError::into_inner);
        match adding.get(&key) {
            Some(cell) => (cell.clone(), true),
            None => {
                let cell = InFlight::default();
                adding.insert(key.clone(), cell.clone());
                (cell, false)
            }
        }
    };
    if joined {
        return cell.wait().clone();
    }
    let result = create_worktree(request, on_step);
    let _ = cell.set(result.clone());
    ADDING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&key);
    result
}

fn send(
    on_step: &mut impl FnMut(WorktreeStep),
    step: StepId,
    state: StepState,
    command: &str,
    error: Option<String>,
) {
    on_step(WorktreeStep {
        step,
        state,
        command: command.to_owned(),
        error,
    });
}

/// Sends `running`, then the work's outcome
fn run_step(
    on_step: &mut impl FnMut(WorktreeStep),
    step: StepId,
    command: &str,
    work: impl FnOnce() -> Result<StepState>,
) -> Result<()> {
    send(on_step, step, StepState::Running, command, None);
    match work() {
        Ok(state) => {
            send(on_step, step, state, command, None);
            Ok(())
        }
        Err(error) => {
            send(
                on_step,
                step,
                StepState::Failed,
                command,
                Some(error.clone()),
            );
            Err(error)
        }
    }
}

fn create_worktree(request: &NewWorktree, mut on_step: impl FnMut(WorktreeStep)) -> Result<String> {
    let repo = Path::new(&request.repo_path);
    let origin = git(repo, ["remote", "get-url", "origin"]).ok();
    let (branch, dir, fetch_args) = match (&request.branch, request.pr) {
        (Some(branch), None) => {
            let name = branch_name(repo, branch)?;
            let dir = worktree_dir(repo, &name);
            (
                Some(name),
                dir,
                vec!["fetch".to_owned(), "origin".to_owned()],
            )
        }
        (None, Some(number)) => {
            // ponytail: GitLab by its host name, self-hosted ones under another name fetch the GitHub ref and fail
            let gitlab = origin.as_deref().is_some_and(|url| url.contains("gitlab"));
            let (prefix, refspec) = if gitlab {
                ("mr", format!("merge-requests/{number}/head"))
            } else {
                ("pr", format!("pull/{number}/head"))
            };
            let dir = worktree_dir(repo, &format!("{prefix}-{number}"));
            (
                None,
                dir,
                vec!["fetch".to_owned(), "origin".to_owned(), refspec],
            )
        }
        _ => return Err("name either a branch or a PR".into()),
    };
    let same_dir = |path: &str| fs::canonicalize(path).ok() == fs::canonicalize(&dir).ok();
    let existing = list_worktrees(&request.repo_path)?
        .into_iter()
        .find(|w| {
            !w.missing
                && match &branch {
                    Some(name) => w.branch.as_ref() == Some(name),
                    None => same_dir(&w.path),
                }
        })
        .map(|w| w.path);

    let fetch = format!("git {}", fetch_args.join(" "));
    let skip_fetch =
        existing.is_some() || (branch.is_some() && (request.skip_fetch || origin.is_none()));
    if skip_fetch {
        send(
            &mut on_step,
            StepId::Fetch,
            StepState::Skipped,
            &fetch,
            None,
        );
    } else {
        run_step(&mut on_step, StepId::Fetch, &fetch, || {
            git(repo, &fetch_args).map(|_| StepState::Done)
        })?;
    }

    let shown = dir
        .strip_prefix(repo)
        .unwrap_or(&dir)
        .to_string_lossy()
        .into_owned();
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    match &branch {
        None => args.extend(["--detach".into(), shown.clone(), "FETCH_HEAD".into()]),
        Some(name) if has_ref(repo, &format!("refs/heads/{name}")) => {
            args.extend([shown.clone(), name.clone()])
        }
        Some(name) if has_ref(repo, &format!("refs/remotes/origin/{name}")) => args.extend([
            "--track".into(),
            "-b".into(),
            name.clone(),
            shown.clone(),
            format!("origin/{name}"),
        ]),
        Some(name) => {
            let base = match &request.base {
                Some(base) => Some(base.clone()),
                None => base_of(repo).map(|(_, base_ref)| base_ref),
            };
            if let Some(base) = &base {
                refuse_option("base", base)?;
            }
            args.extend(["-b".into(), name.clone(), shown.clone()]);
            args.extend(base);
        }
    }
    let add = format!("git {}", args.join(" "));
    let path = match existing {
        Some(path) => {
            run_step(&mut on_step, StepId::Add, &add, || Ok(StepState::Done))?;
            PathBuf::from(path)
        }
        None => {
            run_step(&mut on_step, StepId::Add, &add, || {
                git(repo, &args).map(|_| StepState::Done)
            })?;
            dir
        }
    };

    if request.copy_env {
        copy_env(repo, &path, &mut on_step)?;
    }
    if let Some(setup) = request.setup.as_deref().filter(|s| !s.trim().is_empty()) {
        run_step(&mut on_step, StepId::Setup, setup, || {
            run_setup(&path, setup)
        })?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Copies the main checkout's `.env` and `.env.*` files, keeping any the worktree already has
fn copy_env(repo: &Path, worktree: &Path, on_step: &mut impl FnMut(WorktreeStep)) -> Result<()> {
    let mut names: Vec<String> = fs::read_dir(repo)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name == ".env" || name.starts_with(".env."))
        .collect();
    names.sort();
    let command = format!(
        "cp {}",
        if names.is_empty() {
            ".env".into()
        } else {
            names.join(" ")
        }
    );
    if names.is_empty() {
        send(on_step, StepId::Env, StepState::Skipped, &command, None);
        return Ok(());
    }
    run_step(on_step, StepId::Env, &command, || {
        for name in &names {
            let target = worktree.join(name);
            if !target.exists() {
                fs::copy(repo.join(name), target).map_err(|e| format!("{name}: {e}"))?;
            }
        }
        Ok(StepState::Done)
    })
}

/// Runs the setup command in the user's login shell, so tools on their PATH (bun, pnpm) are found
fn run_setup(dir: &Path, setup: &str) -> Result<StepState> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell)
        .args(["-ilc", setup])
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(StepState::Done);
    }
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let lines: Vec<&str> = output.trim_end().lines().collect();
    let tail = lines[lines.len().saturating_sub(SETUP_ERROR_LINES)..].join("\n");
    Err(if tail.is_empty() {
        format!("{setup} failed ({})", out.status)
    } else {
        tail
    })
}

/// The main checkout of the repository `worktree` belongs to
pub fn main_worktree_of(worktree: &Path) -> Result<PathBuf> {
    let common = git(
        worktree,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    Path::new(common.trim())
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("no repository at {}", worktree.display()))
}

/// Refuses the main checkout. `delete_branch` force-deletes its branch afterwards
pub fn remove_worktree(path: &str, force: bool, delete_branch: bool) -> Result<()> {
    let worktree = Path::new(path);
    let main = main_worktree_of(worktree)?;
    if fs::canonicalize(&main).ok() == fs::canonicalize(worktree).ok() {
        return Err("The main checkout cannot be removed".into());
    }
    let branch = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned());
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    git(&main, args)?;
    match branch.filter(|_| delete_branch) {
        Some(branch) => git(&main, ["branch", "-D", &branch]).map(drop),
        None => Ok(()),
    }
}

/// `git worktree prune`: forgets worktrees whose folder is gone
pub fn prune_worktrees(repo_path: &str) -> Result<()> {
    git(Path::new(repo_path), ["worktree", "prune"]).map(drop)
}

/// Restores a tracked file to HEAD, deletes an untracked or newly added one
pub fn discard_changes(root: &str, file: &str) -> Result<()> {
    crate::fs::inside_root(Path::new(root), file)?;
    let root = Path::new(root);
    if !succeeds(root, ["ls-files", "--error-unmatch", "--", file]) {
        return git(root, ["clean", "-f", "--", file]).map(drop);
    }
    if succeeds(root, ["cat-file", "-e", &format!("HEAD:./{file}")]) {
        git(
            root,
            [
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                file,
            ],
        )
        .map(drop)
    } else {
        git(root, ["rm", "-f", "--quiet", "--", file]).map(drop)
    }
}

#[cfg(test)]
mod tests;
