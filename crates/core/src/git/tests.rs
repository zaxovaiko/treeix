use super::*;
use std::process::Command;

/// Runs git in `cwd` with a test identity; panics on failure
fn sh(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
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

fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = fs::canonicalize(dir.path()).unwrap();
    (dir, path)
}

/// A repo with one commit of `a.txt` on main
fn repo() -> (tempfile::TempDir, PathBuf) {
    let (dir, path) = temp();
    sh(&path, &["init", "-q", "-b", "main"]);
    fs::write(path.join("a.txt"), "one\n").unwrap();
    sh(&path, &["add", "."]);
    sh(&path, &["commit", "-qm", "init"]);
    (dir, path)
}

/// An origin with one commit on main and a clone of it
fn origin_and_clone() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let (dir, root) = temp();
    let origin = root.join("origin");
    let clone = root.join("clone");
    fs::create_dir(&origin).unwrap();
    sh(&origin, &["init", "-q", "-b", "main"]);
    fs::write(origin.join("a.txt"), "one\n").unwrap();
    sh(&origin, &["add", "."]);
    sh(&origin, &["commit", "-qm", "root"]);
    sh(&root, &["clone", "-q", "origin", "clone"]);
    (dir, origin, clone)
}

fn request(repo: &Path, branch: Option<&str>, pr: Option<u32>) -> NewWorktree {
    NewWorktree {
        repo_path: repo.to_string_lossy().into_owned(),
        branch: branch.map(str::to_owned),
        base: None,
        pr,
        copy_env: false,
        setup: None,
        skip_fetch: false,
    }
}

fn add(request: &NewWorktree) -> (Result<String>, Vec<(StepId, StepState)>) {
    let mut steps = Vec::new();
    let result = add_worktree(request, |s| steps.push((s.step, s.state)));
    (result, steps)
}

fn s(path: &str) -> String {
    path.to_owned()
}

#[test]
fn parses_the_worktree_list() {
    let porcelain = "worktree /repo
HEAD 1234567890abcdef
branch refs/heads/main

worktree /repo/.claude/worktrees/feat
HEAD abcdef1234567890
detached

worktree /bare.git
bare
";
    let worktree = |path: &str, head: &str, branch: Option<&str>, main| Worktree {
        path: s(path),
        head: s(head),
        branch: branch.map(s),
        main,
        missing: false,
    };
    assert_eq!(
        parse_worktree_list(porcelain),
        vec![
            worktree("/repo", "1234567", Some("main"), true),
            worktree("/repo/.claude/worktrees/feat", "abcdef1", None, false),
        ]
    );
    // A repo without commits has an all-zero HEAD
    let empty =
        "worktree /new\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n";
    assert_eq!(parse_worktree_list(empty)[0].head, "");
}

#[test]
fn splits_a_patch_per_file() {
    let patch = "diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/dir/b.ts b/dir/b.ts
new file mode 100644
";
    let summary = |patch: &str| -> Vec<(String, u32, u32)> {
        split_patch(patch)
            .into_iter()
            .map(|p| (p.path, p.additions, p.deletions))
            .collect()
    };
    assert_eq!(
        summary(patch),
        vec![(s("a.ts"), 1, 1), (s("dir/b.ts"), 0, 0)]
    );
    // Git quotes paths with non-ASCII bytes, quotes or control characters, spelling bytes in octal
    let quoted = "diff --git \"a/\\303\\251.txt\" \"b/\\303\\251.txt\"\n--- \"a/\\303\\251.txt\"\n+++ \"b/\\303\\251.txt\"\n@@ -1 +1,2 @@\n b\n+b2\n";
    let renamed = "diff --git a/old name.txt \"b/n\\303\\251w \\\"x\\\".txt\"\nsimilarity index 100%\nrename from old name.txt\nrename to \"n\\303\\251w \\\"x\\\".txt\"\n";
    let patches = split_patch(&format!("{quoted}{renamed}"));
    assert_eq!(
        patches
            .iter()
            .map(|p| (p.path.as_str(), p.additions))
            .collect::<Vec<_>>(),
        vec![("é.txt", 1), ("néw \"x\".txt", 0)]
    );
    assert_eq!(patches[1].status, ChangeStatus::Renamed);
    assert_eq!(patches[1].old_path.as_deref(), Some("old name.txt"));
    let statuses: Vec<ChangeStatus> = split_patch(
        "diff --git a/n b/n\nnew file mode 100644\ndiff --git a/d b/d\ndeleted file mode 100644\ndiff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n",
    )
    .into_iter()
    .map(|p| {
        if p.path == "i.png" {
            assert_eq!(p.patch, "");
        }
        p.status
    })
    .collect();
    assert_eq!(
        statuses,
        [
            ChangeStatus::Added,
            ChangeStatus::Deleted,
            ChangeStatus::Modified
        ]
    );
}

#[test]
fn diff_path_and_unquote() {
    assert_eq!(diff_path("diff --git a/x y b/x y"), "x y");
    assert_eq!(diff_path("diff --git \"a/q\\\"\" b/plain"), "plain");
    assert_eq!(unquote_git_path("tab\\there\\\\"), "tab\there\\");
    assert_eq!(diff_path("not a header"), "");
}

#[test]
fn parses_status_porcelain_v2() {
    let porcelain = [
        "# branch.oid 1234567890abcdef",
        "# branch.head feat/x",
        "# branch.upstream origin/feat/x",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
        "1 A. N... 000000 100644 100644 000 bbb new.ts",
        "1 .D N... 100644 100644 000000 aaa aaa gone.ts",
        "2 R. N... 100644 100644 100644 aaa aaa R100 to.ts",
        "from.ts",
        "u UU N... 100644 100644 100644 100644 a b c both.ts",
        "? untracked file.txt",
        "",
    ]
    .join("\0");
    let status = parse_status(&porcelain);
    assert_eq!(status.branch.as_deref(), Some("feat/x"));
    assert_eq!(status.head.as_deref(), Some("1234567"));
    assert_eq!(status.upstream.as_deref(), Some("origin/feat/x"));
    assert_eq!((status.ahead, status.behind, status.gone), (2, 3, false));
    assert_eq!(status.conflicts, vec![s("both.ts")]);
    let changes: Vec<(&str, ChangeStatus, Option<&str>)> = status
        .changes
        .iter()
        .map(|c| (c.path.as_str(), c.status, c.old_path.as_deref()))
        .collect();
    assert_eq!(
        changes,
        vec![
            ("src/a b.ts", ChangeStatus::Modified, None),
            ("new.ts", ChangeStatus::Added, None),
            ("gone.ts", ChangeStatus::Deleted, None),
            ("to.ts", ChangeStatus::Renamed, Some("from.ts")),
            ("both.ts", ChangeStatus::Conflicted, None),
            ("untracked file.txt", ChangeStatus::Untracked, None),
        ]
    );
    let gone =
        parse_status("# branch.oid (initial)\0# branch.head main\0# branch.upstream origin/main\0");
    assert_eq!((gone.head, gone.gone), (None, true));
    assert_eq!(parse_status("# branch.head (detached)\0").branch, None);
}

#[test]
fn parses_track_and_worktree_dir() {
    assert_eq!(parse_track("gone"), (0, 0, true));
    assert_eq!(parse_track("ahead 2, behind 3"), (2, 3, false));
    assert_eq!(parse_track(""), (0, 0, false));
    assert_eq!(
        worktree_dir(Path::new("/repo"), "feat/x"),
        Path::new("/repo/.claude/worktrees/feat+x")
    );
}

#[test]
fn add_discard_and_remove_on_a_real_repository() {
    let (_dir, repo) = repo();
    let path = PathBuf::from(add(&request(&repo, Some("feat/x"), None)).0.unwrap());
    assert_eq!(path, worktree_dir(&repo, "feat/x"));
    assert!(sh(&repo, &["worktree", "list"]).contains("feat+x"));
    assert!(
        add(&request(&repo, Some("bad..name"), None))
            .0
            .unwrap_err()
            .contains("not a valid branch name")
    );
    // Two calls at once, and a branch that already has its worktree, all get the same one
    let y = request(&repo, Some("feat/y"), None);
    let both = std::thread::scope(|scope| {
        let first = scope.spawn(|| add(&y).0);
        let second = scope.spawn(|| add(&y).0);
        [first.join().unwrap(), second.join().unwrap()]
    });
    let y_dir = worktree_dir(&repo, "feat/y").to_string_lossy().into_owned();
    assert_eq!(both, [Ok(y_dir.clone()), Ok(y_dir)]);
    let (again, steps) = add(&request(&repo, Some("feat/x"), None));
    assert_eq!(again.unwrap(), path.to_string_lossy());
    assert_eq!(
        steps,
        vec![
            (StepId::Fetch, StepState::Skipped),
            (StepId::Add, StepState::Running),
            (StepId::Add, StepState::Done),
        ]
    );

    let root = path.to_str().unwrap();
    fs::write(path.join("a.txt"), "changed\n").unwrap();
    fs::write(path.join("new.txt"), "untracked\n").unwrap();
    fs::write(path.join("staged.txt"), "staged\n").unwrap();
    sh(&path, &["add", "staged.txt"]);
    discard_changes(root, "a.txt").unwrap();
    discard_changes(root, "new.txt").unwrap();
    discard_changes(root, "staged.txt").unwrap();
    assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "one\n");
    assert!(!path.join("new.txt").exists());
    assert!(!path.join("staged.txt").exists());
    assert!(
        discard_changes(root, "../escape.txt")
            .unwrap_err()
            .contains("outside the worktree")
    );

    assert!(
        remove_worktree(repo.to_str().unwrap(), false, false)
            .unwrap_err()
            .contains("main checkout")
    );
    fs::write(path.join("dirty.txt"), "x").unwrap();
    assert!(remove_worktree(root, false, false).is_err());
    remove_worktree(root, true, true).unwrap();
    assert!(!path.exists());
    assert!(!sh(&repo, &["branch"]).contains("feat/x"));
}

#[test]
fn lists_branches_with_tracking_merged_state_and_remote_only_ones() {
    let (_dir, origin, clone) = origin_and_clone();
    sh(&origin, &["branch", "remote-only"]);
    sh(&clone, &["fetch", "-q"]);
    sh(&clone, &["branch", "merged-feature"]);
    create_branch(clone.to_str().unwrap(), "ahead-feature", "main").unwrap();
    sh(&clone, &["checkout", "-q", "ahead-feature"]);
    sh(&clone, &["commit", "-q", "--allow-empty", "-m", "work"]);
    sh(&clone, &["branch", "-q", "--set-upstream-to=origin/main"]);
    sh(&clone, &["checkout", "-q", "main"]);

    let repo = clone.to_str().unwrap();
    let branches = list_branches(repo).unwrap();
    let by_name = |name: &str| branches.iter().find(|b| b.name == name);
    let ahead = by_name("ahead-feature").unwrap();
    assert_eq!(
        (ahead.remote, ahead.ahead, ahead.behind, ahead.merged),
        (false, 1, 0, false)
    );
    assert_eq!(ahead.author, "t");
    assert!(by_name("merged-feature").unwrap().merged);
    let main = by_name("main").unwrap();
    assert!(!main.merged);
    assert_eq!(main.worktree.as_deref(), Some(repo));
    assert!(by_name("origin/remote-only").unwrap().remote);
    assert!(by_name("origin/main").is_none());
    assert!(by_name("origin/HEAD").is_none());

    delete_branch(repo, "merged-feature", false).unwrap();
    assert!(delete_branch(repo, "ahead-feature", false).is_err());
    delete_branch(repo, "ahead-feature", true).unwrap();
    assert!(create_branch(repo, "x", "--orphan").is_err());
    assert!(delete_branch(repo, "--force", false).is_err());
    assert!(check_branch_name("feat/ok"));
    assert!(!check_branch_name("bad..name"));
    assert!(!check_branch_name("-x"));
}

#[test]
fn a_new_worktree_off_origin_main_starts_from_what_the_remote_has_now() {
    let (_dir, origin, clone) = origin_and_clone();
    sh(
        &origin,
        &["commit", "-q", "--allow-empty", "-m", "pushed later"],
    );
    let mut new = request(&clone, Some("abc-1"), None);
    new.base = Some(s("origin/main"));
    let (path, steps) = add(&new);
    let path = PathBuf::from(path.unwrap());
    assert_eq!(steps[1], (StepId::Fetch, StepState::Done));
    assert_eq!(
        sh(&path, &["log", "-1", "--format=%s"]).trim(),
        "pushed later"
    );
    // Only on origin: tracks it
    sh(&origin, &["branch", "only-there"]);
    let tracked = PathBuf::from(add(&request(&clone, Some("only-there"), None)).0.unwrap());
    assert_eq!(
        sh(&tracked, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(),
        "origin/only-there"
    );
}

#[test]
fn a_failed_fetch_fails_the_step_and_continuing_without_it_works() {
    let (dir, origin, clone) = origin_and_clone();
    fs::rename(&origin, dir.path().join("moved")).unwrap();
    let mut new = request(&clone, Some("offline"), None);
    let (result, steps) = add(&new);
    assert!(result.is_err());
    assert_eq!(steps.last(), Some(&(StepId::Fetch, StepState::Failed)));
    new.skip_fetch = true;
    let (result, steps) = add(&new);
    assert!(Path::new(&result.unwrap()).exists());
    assert_eq!(steps[0], (StepId::Fetch, StepState::Skipped));
}

#[test]
fn checks_out_a_pr_copies_env_and_runs_setup() {
    let (_dir, origin, clone) = origin_and_clone();
    sh(&origin, &["checkout", "-q", "-b", "contrib"]);
    sh(&origin, &["commit", "-q", "--allow-empty", "-m", "pr work"]);
    sh(&origin, &["update-ref", "refs/pull/7/head", "HEAD"]);
    fs::write(clone.join(".env"), "A=1\n").unwrap();
    fs::write(clone.join(".env.local"), "B=2\n").unwrap();
    let mut pr = request(&clone, None, Some(7));
    pr.copy_env = true;
    pr.setup = Some(s("echo ran > setup.txt"));
    let mut steps = Vec::new();
    let path = add_worktree(&pr, |step| steps.push(step)).unwrap();
    let path = PathBuf::from(path);
    assert_eq!(path, worktree_dir(&clone, "pr-7"));
    assert_eq!(sh(&path, &["log", "-1", "--format=%s"]).trim(), "pr work");
    assert_eq!(
        fs::read_to_string(path.join(".env.local")).unwrap(),
        "B=2\n"
    );
    assert_eq!(
        fs::read_to_string(path.join("setup.txt")).unwrap().trim(),
        "ran"
    );
    let shown: Vec<(StepId, StepState, &str)> = steps
        .iter()
        .filter(|s| s.state != StepState::Running)
        .map(|s| (s.step, s.state, s.command.as_str()))
        .collect();
    assert_eq!(
        shown,
        vec![
            (
                StepId::Fetch,
                StepState::Done,
                "git fetch origin pull/7/head"
            ),
            (
                StepId::Add,
                StepState::Done,
                "git worktree add --detach .claude/worktrees/pr-7 FETCH_HEAD"
            ),
            (StepId::Env, StepState::Done, "cp .env .env.local"),
            (StepId::Setup, StepState::Done, "echo ran > setup.txt"),
        ]
    );

    // Retry with a failing setup reuses the worktree and reports the output tail
    pr.setup = Some(s("echo boom; exit 3"));
    let mut failed = None;
    let result = add_worktree(&pr, |step| {
        if step.state == StepState::Failed {
            failed = step.error;
        }
    });
    assert!(result.unwrap_err().contains("boom"));
    assert!(failed.unwrap().contains("boom"));
}

#[test]
fn status_tracks_base_upstream_gone_and_merged() {
    let (_dir, origin, clone) = origin_and_clone();
    let repo = clone.to_str().unwrap();
    let main = git_status(repo).unwrap().unwrap();
    assert_eq!(main.base.as_deref(), Some("main"));
    assert_eq!(
        (main.branch.as_deref(), main.merged, main.base_ahead),
        (Some("main"), false, 0)
    );

    let path = PathBuf::from(add(&request(&clone, Some("feat"), None)).0.unwrap());
    let root = path.to_str().unwrap();
    // A fresh branch has nothing to clean up
    assert!(!git_status(root).unwrap().unwrap().merged);
    fs::write(path.join("b.txt"), "b\n").unwrap();
    sh(&path, &["add", "."]);
    sh(&path, &["commit", "-qm", "b"]);
    fs::write(path.join("a.txt"), "two\n").unwrap();
    fs::write(path.join("c.txt"), "c\n").unwrap();
    sh(&path, &["push", "-q", "-u", "origin", "feat"]);
    let status = git_status(root).unwrap().unwrap();
    assert_eq!(
        (status.base_ahead, status.ahead, status.merged, status.gone),
        (1, 0, false, false)
    );
    assert_eq!(status.upstream.as_deref(), Some("origin/feat"));
    let changes: Vec<(&str, ChangeStatus)> = status
        .changes
        .iter()
        .map(|c| (c.path.as_str(), c.status))
        .collect();
    assert_eq!(
        changes,
        vec![
            ("a.txt", ChangeStatus::Modified),
            ("c.txt", ChangeStatus::Untracked)
        ]
    );

    let local = diff(root, DiffScope::Local).unwrap();
    let summary = |patches: &[FilePatch]| -> Vec<(String, ChangeStatus, u32, u32)> {
        patches
            .iter()
            .map(|p| (p.path.clone(), p.status, p.additions, p.deletions))
            .collect()
    };
    assert_eq!(
        summary(&local),
        vec![
            (s("a.txt"), ChangeStatus::Modified, 1, 1),
            (s("c.txt"), ChangeStatus::Untracked, 1, 0)
        ]
    );
    let base = diff(root, DiffScope::Base).unwrap();
    assert_eq!(
        summary(&base),
        vec![
            (s("a.txt"), ChangeStatus::Modified, 1, 1),
            (s("b.txt"), ChangeStatus::Added, 1, 0),
            (s("c.txt"), ChangeStatus::Untracked, 1, 0),
        ]
    );

    assert_eq!(
        read_file_at(root, "a.txt", "HEAD").unwrap().as_deref(),
        Some("one\n")
    );
    assert_eq!(read_file_at(root, "b.txt", "origin/main").unwrap(), None);
    assert!(read_file_at(root, "../x", "HEAD").is_err());
    let log = file_log(root, "b.txt").unwrap();
    assert_eq!(
        log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
        ["b"]
    );
    let commit = commit_diff(root, &log[0].sha, None).unwrap();
    assert_eq!(
        summary(&commit),
        vec![(s("b.txt"), ChangeStatus::Added, 1, 0)]
    );

    // Squash-merged: the remote branch is deleted, so the upstream is gone
    sh(&origin, &["branch", "-D", "feat"]);
    sh(&path, &["fetch", "-q", "--prune"]);
    let status = git_status(root).unwrap().unwrap();
    assert!(status.gone && status.merged);

    let (_plain, folder) = temp();
    assert_eq!(git_status(folder.to_str().unwrap()).unwrap(), None);
}

#[test]
fn status_reports_a_rebase_with_conflicts() {
    let (_dir, repo) = repo();
    sh(&repo, &["checkout", "-q", "-b", "topic"]);
    fs::write(repo.join("a.txt"), "topic\n").unwrap();
    sh(&repo, &["commit", "-qam", "topic"]);
    sh(&repo, &["checkout", "-q", "main"]);
    fs::write(repo.join("a.txt"), "main\n").unwrap();
    sh(&repo, &["commit", "-qam", "main"]);
    sh(&repo, &["checkout", "-q", "topic"]);
    let rebase = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["rebase", "-q", "main"])
        .output()
        .unwrap();
    assert!(!rebase.status.success());
    let status = git_status(repo.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(status.rebase, Some(Rebase { step: 1, total: 1 }));
    assert_eq!(status.conflicts, vec![s("a.txt")]);
    assert_eq!(status.branch, None);
}

#[test]
fn lists_worktrees_with_missing_ones_flagged() {
    let (_dir, repo) = repo();
    let path = PathBuf::from(add(&request(&repo, Some("gone"), None)).0.unwrap());
    fs::remove_dir_all(&path).unwrap();
    let worktrees = list_worktrees(repo.to_str().unwrap()).unwrap();
    assert_eq!(
        worktrees
            .iter()
            .map(|w| (w.main, w.missing))
            .collect::<Vec<_>>(),
        vec![(true, false), (false, true)]
    );
    prune_worktrees(repo.to_str().unwrap()).unwrap();
    assert_eq!(list_worktrees(repo.to_str().unwrap()).unwrap().len(), 1);
}
