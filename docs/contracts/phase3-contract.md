# Phase 3 contract: git, files, PRs, history

The shared surface the five Phase 3 agents build against. The UI talks to `Api` in `apps/desktop/src/ipc/api.ts` only. `tauri.ts` maps it to the generated commands, and `mock.ts` implements it in memory for the dev server, Playwright and screenshots.

- Rust commands: `apps/desktop/src-tauri/src/commands/{git,files,prs,history}.rs`. Each is registered in `lib.rs` and returns `Err("not implemented")` until its owner fills it in.
- Types: `crates/core/src/{git,fs,search,prs,history}.rs`, with serde camelCase and `specta::Type`. `bindings.ts` is generated from them: `CARGO_TARGET_DIR=... cargo test -p treeix-app export_bindings`.
- The hand-written types in `api.ts` mirror the Rust ones field for field. If you change a Rust type, change its `api.ts` twin and the mock in the same commit.

## Rules for every command

- `root` is a place path: a checkout, a worktree or a folder. `file` is relative to it.
  - Port `insideWorktree`: resolve `root/file` (symlinks included) and refuse anything outside `root` with an error. This applies to every command taking `root` + `file`, and to `rename_path`'s `to`.
- git, gh and glab run as subprocesses: `git --no-optional-locks`, never libgit2. Long work goes in `spawn_blocking`.
- Errors are `String`s and reach the UI as a rejected promise with that message. Keep git's own stderr when it says more than we would.
- No `unwrap` on external input.

## Surface

### Git (R1: `core::git`, `commands/git.rs`)

- `listWorktrees(repoPath)`: the main checkout first, then linked worktrees, missing ones flagged `missing`.
- `gitStatus(path)`: everything about one checkout, or null outside git.
  - branch, head, upstream, ahead/behind, gone, base (default branch), baseAhead, merged
  - rebase step/total, conflicts, uncommitted changes (untracked included)
- `diff(path, 'local' | 'base')`: per-file unified patches.
  - local is HEAD vs the working tree, untracked files as additions (max 200 untracked, like git.ts).
  - base is merge-base(origin/base) vs the working tree.
- `readFileAt(root, file, rev)`: the file at HEAD, at a base ref or at a sha; null when missing there or binary. It replaces `readHeadFile`.
- `fileLog(root, file)`: commits touching the file, newest first, `--follow`.
- `commitDiff(root, sha, file?)`: what one commit changed.
- `listBranches(repoPath)`: local branches plus origin-only ones, newest first. Each carries the worktree that has it checked out.
- `checkBranchName(name)`: `git check-ref-format --branch`.
- `createBranch(repoPath, name, base)`
- `deleteBranch(repoPath, name, force)`: a safe delete unless `force`. Squash-merged branches need `force`.
- `addWorktree(request, onStep)`: see "Worktree creation" below. Resolves with the path.
- `removeWorktree(path, force, deleteBranch)`: refuses the main checkout. `deleteBranch` force-deletes the branch afterwards, as Cleanup does for merged branches.
- `pruneWorktrees(repoPath)`: `git worktree prune`.
- `discardChanges(root, file)`: restores a tracked file to HEAD, deletes an untracked one.

### Files and search (R2: `core::fs`, `core::search`, `commands/files.rs`)

- `listFiles(root)` returns `{ files, ignored }`, or null when the root is gone.
  - Walk with `ignore`, which works for non-git folders too.
  - `ignored` lists ignored entries; folders end in `/` and are not expanded.
- `listDirectory(root, folder)`: names in one folder, folders ending in `/`, ignored ones included.
- `readFile(root, file)`: null for binary (a NUL in the first 8 KB) or files over 2 MB.
- `saveFile(root, file, contents, expected)`
  - Snapshots the old version into local history first.
  - Rejects with a message containing `SAVE_CONFLICT` when the disk no longer matches `expected`. `null` overwrites.
- `createPath(root, file)`: a trailing `/` creates a folder; parents are created too.
- `renamePath(root, from, to)`
- `trashPath(root, file)`: system Trash, via the `trash` crate.
- `revealInFinder(path)`, `openPath(path)` (default app), `openUrl(url)` (http and https only).
- `searchText(roots, query, { caseSensitive, wholeWord, regex })` returns `{ matches, truncated }`.
  - Uses `ignore` + `grep-searcher` + `grep-regex`.
  - Limits: 2000 matches, 100 per file, lines cut to 400 chars.
  - `column` and `length` are in UTF-16 units.
  - An invalid regex rejects with the regex error, and the dialog shows it.
- `watchFile(root, file, cb)` and `watchPlace(root, cb)`: subscriptions that return their unsubscribe. See "Events".

### Pull requests (R2: `core::prs`, `commands/prs.rs`)

- `listPullRequests(repoPaths)` returns `{ pullRequests, errors }`.
  - It returns open PRs plus recently merged or closed ones.
  - A repo that fails (CLI missing, signed out, offline) lands in `errors`, and the rest still list.
  - Port `parseRemote`, `toGithubPullRequest`, `toGitlabPullRequest` and their tests.
  - `pipeline.done`/`total` feed "CI 3/5".
- `prChecks(pr)`: the head commit's checks (`gh pr checks`) or pipeline jobs (glab).
- `mergePullRequest(pr, method, deleteBranch)`: `gh pr merge` / `glab mr merge`.
- `prProviders()`: gh and glab, installed / signed in / login. It feeds the footer ("GitHub via gh"), the signed-out banner and the "Mine" filter.
- To check out a PR, call `addWorktree({ pr: number, ... })`. It is not a separate method.

### History (R2: `core::history`, `commands/history.rs`)

- `listHistory(root, file)` and `readHistory(root, file, id)`: local snapshots, a port of history.ts.
  - Stored in app data under `sha1(root \0 file)`.
  - 60 s minimum gap, 100 kept, ids are ms timestamps.
- `sessionHistory()`: closed sessions, newest first.
  - R2 records one when a session is removed. Keep it in a JSONL in app data, next to the UI state, and fill `branch` and `repoRoot` from `places::resolve` at close time.
  - `messages`, `cost` and `firstPrompt` stay null until Phase 4 reads the agent transcripts.
  - Hooking the record into the remove path touches `commands.rs` `remove`; R2 owns that one-line call.
- `forgetSession(id)`
- Resume, Fork and Reopen call the existing `create`:
  - claude: `['claude', '--resume', agentSession]`; fork adds `--fork-session`
  - codex: `['codex', 'resume', agentSession]`
  - shell: `command`

## Events and progress

### Worktree creation

`addWorktree(request, onStep)` sends each step on a Tauri `Channel<WorktreeStep>`, in order:

| step | command | notes |
| --- | --- | --- |
| `fetch` | `git fetch origin`; for a PR `git fetch origin pull/N/head` (GitHub) or `merge-requests/N/head` (GitLab) | `skipFetch` turns it into `skipped` (never for PRs) |
| `add` | `git worktree add <dir> <branch>`, `-b <branch> <base>` for a new branch, `--track` for origin-only, `--detach <dir> FETCH_HEAD` for a PR | dir: `<repo>/.claude/worktrees/<branch with / as +>`, PRs `pr-N` / `mr-N` |
| `env` | copy `.env` and `.env.*` from the main checkout | only when `copyEnv`; `skipped` when there is none |
| `setup` | the repo's setup command (`bun install`), run in the new worktree | only when `setup` is set; `error` carries the output tail |

- Each step is sent as `running`, then `done`, `failed` or `skipped`. A failed step carries `error`, and then the promise rejects with the same message.
- Retry calls `addWorktree` again with the same request.
  - The call is idempotent: a worktree that already exists for the branch or PR is reused, so `add` reports `done` at once.
  - Concurrent calls for the same key join the one in flight (git.ts dedupe).
- "Continue without fetching" calls again with `skipFetch: true`.
- "Start agent" and "Open a shell" are UI steps after the promise resolves (`create` with the new path).

### File and place watching

- `watch(id, root, file | null)` and `unwatch(id)` are commands. Changes arrive as the `FsEvent { id, paths, git }` event (`events.fsEvent` in bindings).
  - The UI never calls them directly; `watchFile` and `watchPlace` wrap them with a random id per subscriber.
- R2 implements them with `notify-debouncer-full` at about 200 ms.
  - Keep the watch registry in a `static` (`OnceLock<Mutex<HashMap<id, Debouncer>>>`) in `commands/files.rs`, so `lib.rs` needs no setup change.
  - The same id replaces its watch.
- `paths` is relative to `root`, with `.git` left out. `git: true` when anything under `.git` changed (index, HEAD, refs).
  - On `git: true`, the Changes panel and the sidebar re-run `gitStatus`.
  - The Explorer re-runs `listFiles` on path changes.
- `watchFile` fires on our own saves too. The file view compares with what it saved and ignores the echo.
- No polling in the UI. The PR list is the exception: no event exists for it, so the panel refreshes on focus and every 60 s while visible.

## Not in this contract

- Commit, push, publish, pull, rebase abort/continue, `git init`, open PR (`gh pr create --draft --fill`), add remote, `gh auth login` and "Clone and check out" all run in a shell session (`create` with the command), as in the prototype's `runIn`. They have no API.
- Electron's `scan()` (home walk for repos) is left out: places come from sessions and the sidebar.
- The "written by agents" list on non-git folders is Phase 4 (agents).
- Images and PDFs (`readImage`, `readPdf`): binary files offer "Open with default app" (`openPath`) for now.

## Who implements what

- R1: `crates/core/src/git.rs`, `commands/git.rs`, git.ts tests ported 1:1 (parseWorktreeList, splitPatch, diffPath, unquoteGitPath, parseTrack, worktreeDir, defaultBranch).
- R2: `crates/core/src/{fs,search,prs,history}.rs`, `commands/{files,prs,history}.rs`, plus the session-close record. Port the tests of files.ts, paths.ts, history.ts and prs.ts.
- U1, side panels: Explorer, Changes, PRs and History, plus the activity bar.
- U2, dialogs: Open worktree, Worktrees / Cleanup, Find in files.
- U3, file view: Monaco editor, @pierre/diffs, the comments drawer and File history.

The UI agents work against the mock (`?seed=empty` for first run, `window.treeixMock.offline = true` for a failed fetch). The Rust agents work against `bindings.ts`, so no UI change is needed once a command lands.

## UI placement (from the prototype)

- Activity bar on the right panel (`rpanel`): Explorer (⇧⌘E), Changes (⌃⇧G, badge = uncommitted count), PRs (badge = PRs that need you), History.
- Explorer
  - The place's tree from `listFiles`, colored by `gitStatus.changes` (U untracked, M modified) and `ignored` (I, dimmed). A dot on folders that hold changes.
  - Filter input and Collapse all at the top.
  - Context menu: new file / folder (`createPath`), rename, Trash, Reveal in Finder, Copy path.
  - Scratch (`~`) shows the empty state.
- Changes
  - Scope segment "vs base" / "uncommitted" (only uncommitted on the base branch).
  - Files with A/M/D/U letters and +/-, expanding to hunks. Each line has a comment button, and the threads go to the agent.
  - Banners:
    - merged: Clean up
    - rebase N/M: the conflict list, Abort / Continue (run in a shell)
    - behind N: Pull
  - Footer: Commit, Push ⇡N / Publish / Add remote, the PR link or Open PR, Ask Claude to review (all shell or agent).
  - A non-git folder shows "Not a git repository" with git init; scratch shows "no folder".
- PRs
  - Filters All / Mine / Review (`review.state === 'requested'`).
  - Rows show the CI dot and text, a review tag and +/-.
  - Actions:
    - Open worktree (it exists)
    - Check out in worktree (`addWorktree({ pr })`)
    - Clean up (merged)
    - Review with Claude, Fix CI (agent sessions)
    - Merge
    - Open in browser (`openUrl`)
  - Banners: offline (cached list), gh signed out (`prProviders`). The footer shows the sources.
- History
  - "Open now" (current tabs), then closed sessions grouped by day: kind icon, title, place label, messages, cost, age, first prompt.
  - Actions: Resume, Fork, Reopen, "Resume in repo folder" when the worktree is gone, "Recreate worktree" (`addWorktree({ branch })`).
  - Tags: worktree missing, branch deleted, worktree removed.
  - Kind filter all / claude / codex / shell, search, and an "Only <place>" checkbox.
- Open worktree dialog (sidebar repo +, the PR row)
  - Branch picker:
    - "Create <typed name>"
    - local branches with where they are open (`Branch.worktree`)
    - origin-only branches with author and age
  - Live checks:
    - no commits yet (`gitStatus.head === null`)
    - invalid name (`checkBranchName`)
    - used by a missing worktree (offers Prune)
    - exists (checked out)
    - only on origin (tracks it)
  - Options: copy .env, run setup.
  - Then the step list. A failure shows the error with Cancel / Continue without fetching / Retry.
- Worktrees / Cleanup dialog (sidebar repo menu, the merged banner)
  - One row per worktree of each repo, built from `listWorktrees` + `gitStatus`:
    - state: missing, rebasing, merged, PR open (with CI dot), detached, not merged
    - ahead/behind and the session count
  - "Select merged and gone", then Remove N. Merged rows also delete the branch; missing ones are pruned.
  - Remove warns about uncommitted files, unpushed commits and sessions that will close.
- Find in files (⇧⌘F)
  - Query with Aa / ab / .* toggles. Results are grouped by file, 8 rows per file until expanded.
  - The regex error shows inline. Opening a result opens the file view at line/column.
- File view (a page tab)
  - Tabs, breadcrumb, Monaco (`readFile` / `saveFile` with `expected`, reload on `watchFile`).
  - Gutter diff vs base (`readFileAt(root, file, 'origin/<base>')`) with a peek of removed lines.
  - "Ask Claude" on a selection.
  - The comments drawer, and a diff mode with @pierre/diffs over `diff()` patches.
  - File history button:
    - git commits (`fileLog`) with that commit's hunk (`commitDiff`)
    - local saves (`listHistory` / `readHistory`)
    - "Restore this version" saves it through `saveFile`
  - Binary files offer "Open with default app".
