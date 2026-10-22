# Phase 6-7 contract: routines, browser, plans, module graph, dictation, recording

The shared surface the Phase 6-7 agents build against. The UI talks to `Api` in `apps/desktop/src/ipc/api.ts` only. `tauri.ts` maps it to the generated commands. The mock implements it in memory: `mockRoutines.ts`, `mockBrowser.ts`, `mockPlans.ts` and `mockVoice.ts`, spread into `mock.ts`.

- Rust commands live in `apps/desktop/src-tauri/src/commands/{routines,browser,plans,graph,voice}.rs`, all registered in `lib.rs`, events in `collect_events!`.
  - Routine commands already forward to ptyd for real; ptyd answers `Err("not implemented")` until R6 fills `routines::handle`.
  - `routineNextFires` already works (`core::routines::next_fires`, croner).
  - Browser, plan, graph and voice commands call stubs in `src-tauri/src/browser/mod.rs`, `core::plans`, `core::graph` and `src-tauri/src/voice.rs` that return `Err("not implemented")`.
- Types:
  - Routine types are in `crates/proto/src/routines.rs` (ptyd and the app share them, specta behind the proto `specta` feature).
  - Plans and the graph: `crates/core/src/{plans.rs,graph/mod.rs}`. Browser: `src-tauri/src/browser/mod.rs`. Voice: `src-tauri/src/voice.rs`.
  - `api.ts` re-exports them from `bindings.ts`. Change the Rust type, regenerate, update the mock: `CARGO_TARGET_DIR=... cargo test -p treeix-app export_bindings`.
- Proto is at version 4:
  - Appended: `SessionKind::Routine`, `SessionInfo.routine` / `CreateSession.routine`, `Request::{RoutineList, RoutinePut, RoutineRemove, RoutineRunNow, RoutineRuns, RunCancel}`, `Response::{Routines, Routine, Runs, Run}`, `Event::{RoutineChanged, RoutineRemoved, RunChanged}`. Never reorder: postcard encodes by index.
  - `Routine` holds tagged enums (`Trigger`), so it travels as JSON inside the frame (`chat::as_json`).
- Pinned: `croner` 4.0.2 (jiff backend), `oxc` 0.152.0 + `oxc_resolver` 11.24.3 (oxc 0.155 needs rustc 1.97), tauri `unstable` feature (child webviews), `mermaid` 12.0.0 in apps/desktop.

## Rules for every command

- The Phase 3-5 rules apply: subprocesses for git, gh, acli, claude and codex, never libgit2; String errors at the command boundary; no `unwrap` on external input; long work in `spawn_blocking`.
- Path commands refuse paths outside their place (`graphScan` stays under `root`, `planRead` takes a file name, never a path).
- A feature that is off does no work: no poller, no webhook listener, no webview, no helper process, no MCP tools. Its UI is hidden too (see Features).
- Webhook and MCP listeners bind 127.0.0.1 only.

## Surface

### Routines (R6: ptyd `routines/`, U7: the UI)

- `routineList()`: every routine, sorted by name.
- `routinePut(routine)`: creates (empty `id`) or replaces; ptyd fills `id`, `createdAt` and, for a webhook trigger with an empty token, the token. Rejects an empty name or a bad cron.
- `routineRemove(id)`: its runs stay in History.
- `routineRunNow(id)`: queues a `manual` run, even of a disabled routine; returns it `queued` or `running`.
- `routineRuns(routine | null, limit)`: newest first.
- `routineCancelRun(run)`: kills its session; the run ends `cancelled`.
- `routineNextFires(cron, count)`: next fire times in local time, for the editor's preview; throws on a bad cron.
- `onRoutines(cb)`: `{ type: 'changed', routine }`, `{ type: 'removed', routine }`, `{ type: 'run', run }` on every status, turns or cost change. Goes to every window.
- Engine (R6):
  - Routines in `<data dir>/routines/routines.json`, runs in `routines/runs.jsonl`. Runs that were `running` when ptyd died end `failed`.
  - Triggers:
    - `schedule`: 5-field cron, local time (`schedule.rs`, a minute tick).
    - `event`: `gh api` with `If-None-Match` every 60 s for review requested, CI failed, PR comment; `acli` for ticket assigned (`triggers.rs`). Each hit fires once per routine. Prompt vars `{pr} {title} {author} {branch} {job} {ticket} {desc} {body}` (`triggers::render`).
    - `webhook`: `POST http://127.0.0.1:47311/r/<token>` (`WEBHOOK_PORT`), the body is `{body}`.
  - Place: `root` (repo folder), `newWorktree` (a fresh worktree per run on a `routine/<name>-<date>` branch), `prWorktree` (the PR's worktree, added when missing; PR events only).
  - Budget: `--max-turns` on the command line; cost read from the transcript while it runs (`budget.rs`), killed past `maxCost`, ends `overBudget` with "Stopped at the $X budget".
  - Permissions: `readOnly` / `editFiles` / `anything` map to Claude `--permission-mode` (plan / acceptEdits / bypassPermissions) or Codex `--sandbox`, plus `allowedTools`. The agent never gets git push or PR-writing `gh`/`glab` commands; `mayComment` (PR events) allows PR comments and reviews.
  - Result: `local` (commits stay in the worktree), `draftPr` (`newWorktree` only: after a clean exit Treeix commits leftovers, pushes the run branch and opens a draft PR titled by the first commit, body = the agent's last reply; while that PR is open, later runs reuse its branch and add to it), `pushToPr` (`prWorktree` only: the worktree is fast-forwarded to the PR head first, then pushed back). A `newWorktree` run with no commits and a clean tree removes its worktree. Runs record `branch`, `pr { number, url }` and `summary` (last reply).
  - Queue: `settings.routines.maxParallel` slots (default 2); the rest wait `queued`.
  - Asleep: wall clock jumping ahead of the monotonic one means the machine slept. `catchUp` runs a missed schedule once (cause `catchUp`), `skip` records it `skipped` with "The Mac was asleep". No pmset, no IOKit.
  - `settings.routines.background` off: ptyd fires only while an app is connected.
  - A run is a `SessionKind::Routine` session with `SessionInfo.routine` set; its History record carries `SessionRecord.run`.

### Browser pane (B7: `src-tauri/src/browser/`, `features/browser/`)

- `browserOpen(pane, url)`: creates the child webview for a pane id (`Window::add_child`, hidden until placed); returns its state. Idempotent per pane.
- `browserPlace(pane, bounds | null)`: CSS pixels of the pane's slot; null hides it. The pane hides it while a popover, dialog, palette or page covers it.
- `browserClose(pane)`: drops the webview; fires `closed`.
- `browserNavigate(pane, input)`: a URL, a host (`localhost:5173`, `example.com`) or a search through `settings.browser.searchUrl`.
- `browserGo(pane, 'back' | 'forward' | 'reload' | 'stop')`.
- `browserDevtools(pane)`: the webview inspector.
- `browserCookieProfiles()`: Chromium-family, Firefox and Safari profiles; `blocked` without Full Disk Access.
- `browserImportCookies(profile)`: copies cookies into the shared browser data; `{ imported, skipped, error }`.
- `browserClearData()`: cookies, storage and cache of every browser pane.
- `browserDevCommand(folder)`: the folder's dev server command (`package.json` `dev` with its package manager, or null), for the start page.
- `onBrowser(cb)`: `changed` (url, title, loading, back/forward, error "Nothing is answering on <host>"), `entries` (console and network rows, `reset` on navigation), `closed`.
- MCP tools (`browser::tools`, listed by `commands/mcp.rs`): `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`. Empty while the feature or `settings.browser.agents` is off.

### Plan pane (G7: `core::plans`, `features/plans/`)

- `plansList()`: `~/.claude/plans/*.md`, newest first, title from the first heading.
- `planRead(name)`: the markdown; refuses names with a path.
- No plans event: re-list on the `~/.claude/plans` watcher (`watchPlace`) or when a chat's plan changes.

### Module graph (G7: `core::graph`, `features/graph/`)

- `graphScan(root)`: oxc_parser over the git-tracked `.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte` files under `root`, oxc_resolver with tsconfig paths, package exports and workspaces. Grouping and "why does A import B" happen in the webview.
  - Returns `packages`, `files` (with their package), `imports` (`from`, `to` or null, `specifier`, `kind` static/dynamic/type/require, `external`, `unresolved`, `line`), `cycles` and per-file parse `errors`.

### Dictation and recording (V7: `src-tauri/src/voice.rs`, `native/voice`, `features/voice/`)

- The Swift package is copied to `apps/desktop/native/voice`. V7 builds it into `src-tauri/binaries/` and adds it to `bundle.externalBin` (tauri-build fails while the files are missing, so it is not listed yet).
- `dictationStatus()`: helper state, models, microphone and accessibility access, phase.
- `dictationToggle()`: starts or stops listening (the hotkey does the same natively, `settings.dictation.hotkey`).
- `voiceModelDownload(model)` / `voiceModelDelete(model)`: progress through `dictation` events.
- `voiceRequestAccess('microphone' | 'accessibility')`.
- `dictationHistory()`: newest first.
- `recordingStatus()` / `recordingStart(title | null)` / `recordingPause(paused)` / `recordingStop()`: stop goes `saving`, then `idle` with a `saved` event.
- `recordings()` / `recordingRead(id)`: info, transcript and the note (null until summarized).
- `onVoice(cb)`: `dictation` (status), `partial` (live text), `dictated` (an entry, inserted at the cursor), `recording` (status), `transcript` (a line), `saved` (a recording).

## Features

- `features.ts` has `routines`, `browser`, `plans`, `graph` (on by default), `dictation`, `recording` (off by default: Apple silicon only). More > Features lists a switch for each.
- Settings sections: `routines` (Agents, after Chats), `browser`, `voice` (Dictation), `recording` (Tools, before Keep awake). `DEFAULT_SETTINGS` mirrors the Rust defaults.
- Already wired, owners fill the stubs and never touch the shared files:
  - `pages/settings/{index,sections}.tsx` point at `RoutinesSection`, `BrowserSection`, `VoiceSection`, `RecordingSection`.
  - `shell/Panes.tsx` renders `browser:<pane>` and `plan:<name>` leaves (`features/{browser,plans}/open.tsx` for head and close, `index.tsx` lazy-loaded for the pane).
  - `shell/Shell.tsx`: page `'graph'` (lazy `features/graph`), commands `module-graph` and `record` (`toggleRecording`), both gated on the feature.
  - `shell/shortcuts.ts` + `lib/hotkeys`: `module-graph` ⇧⌘G / Ctrl+Shift+M (Ctrl+Shift+G is Changes), `record` ⇧⌘R / Ctrl+Shift+R. Both rebindable.
  - `panels/Panels.tsx`: the activity bar's Module graph button, disabled for scratch.
  - `shell/Palette.tsx`: `routineCommands`, `browserCommands`, `planCommands`, `graphCommands`, `voiceCommands`, each gated.
  - `shell/Chrome.tsx`: `VoiceTitleItems` after the usage pill in both title bars.
  - `lib/icons.tsx`: clock, globe, mic, rec, network, play, file.
- Leaves for browser and plan panes are not sessions, so `restore` drops them on restart, like file views.

## Not in this contract

- The browser's design-pick mode and Perf tab.
- The Meetings page: recordings open as notes from the "Meeting saved" toast and Settings > Meeting recording.
- pmset wake scheduling: asleep is handled on wake only.
- Plugin store.

## Who implements what

- R6, routines engine
  - ptyd `routines/{mod,schedule,triggers,budget}.rs`; drop each `#[expect(dead_code)]` as it gets wired.
  - Spawning runs as `SessionKind::Routine` sessions, History records with `run`, persistence, the webhook listener.
  - Tests for `schedule::due`, `triggers::render`, `budget::breach` and the queue.
- U7, routines UI
  - `features/routines/`: Settings > Routines (list, Run now, toggle, last-run status, templates when empty, "While Treeix is closed"), the editor modal, palette entries, the clock tag on run tabs, toasts, the routine in History.
- B7, browser pane
  - `src-tauri/src/browser/` (the only module touching the unstable webview API), `commands/browser.rs`, the MCP tools.
  - `features/browser/`: bar, start page with live localhost ports (`sessionPorts` + `browserDevCommand`), dev strip, Settings > Browser, "Open in browser" from the ports popover (`openBrowser`).
- G7, plan pane and module graph
  - `core::plans`, `core::graph` (+ tests on a fixture tree), `commands/{plans,graph}.rs`.
  - `features/plans/` (markdown + mermaid, Source view, line comments, "Send to Claude") and `features/graph/`.
- V7, dictation and recording
  - `native/voice` build, externalBin, `src-tauri/src/voice.rs`, `commands/voice.rs`.
  - `features/voice/`: title bar items, HUDs, Settings > Dictation and > Meeting recording, toasts.

The UI agents work against the mock (`?seed=empty` for first run). The seeded data includes:
- six routines, one per trigger kind, and runs that passed, failed, went over budget, caught up and were skipped asleep; History's "Review requested PRs" session is run-1.
- a browser on localhost:5173 with a 500 and a TypeError; other localhost ports answer nothing; Safari cookies are blocked.
- two plans, one with a mermaid flowchart; a graph with a cycle, an unresolved import and a parse error.
- dictation with parakeet-v3 ready and accessibility not asked; two saved recordings.

## UI placement (from the prototype)

- Routines
  - Settings > Agents > Routines (clock). Rows: name, trigger, Run now (play), Edit, a switch; status shows the last run, "Missed: the Mac was asleep", "Stopped at the $5.00 budget". Templates when empty.
  - Group "While Treeix is closed": "Run routines when Treeix is closed" (`background`), "Runs at the same time" 1 / 2 / 3 (`maxParallel`).
  - Editor modal "New routine" / "Edit routine": Name, Agent (seg), Runs (schedule / event / webhook), Every + At or the event seg or the webhook curl snippet, Where, "Each run in" (Repo folder / New worktree / PR's worktree), Prompt with vars, "Agent may" (Read only / Edit files / Anything), Budget $, "May push, open PRs and post comments", Delete / Cancel / Create routine.
  - Palette: "Routines", "New routine...", "Run routine: <name>".
  - Run tabs get a clock tag "Started by the routine <name>". Toasts: "<name> started Claude", "<name> is waiting", "<name> did not start".
- Browser
  - Palette "New browser pane" (globe): a split right of the focused pane.
  - Bar: back, reload, address "Search or type a URL", DevTools (layers), open in the default browser (link).
  - Start page: chips of live localhost ports and the place's dev command.
  - Dev strip: Console / Network with "Send to agent" on errors.
  - Ports popover: "Open in browser" calls `openBrowser(view, 'localhost:<port>')`.
- Plan pane: header "PLAN.md · <title>", Preview / Source seg, line comments, footer "N comments on the plan" and "Send to Claude".
- Module graph
  - Activity bar button (network) "Module graph (⇧⌘G)", disabled for scratch.
  - Page with a "Terminal" back button, Packages / Folders / Files seg, an oxc-resolver tag, Re-scan.
  - Side: "Why does A import B?", Cycles, Unresolved imports, Selected, Legend.
- Dictation and recording
  - Title bar: Record pill "Record a meeting (⇧⌘R)", a "REC mm:ss" pill while recording; mic icon "Dictation: hold ⌥Space" (the hotkey comes from `settings.dictation.hotkey`).
  - Meeting HUD: timer, title, wave, transcript, Pause / Resume, "Stop and summarize", hide.
  - Dictation HUD: wave, text, "into <app>", Insert.
  - Toast "Meeting saved" with Open notes / Ask Claude.
  - Settings > Tools: Browser, Dictation, Meeting recording, Keep awake.
- Keys: Module graph ⇧⌘G, Record a meeting ⇧⌘R, Dictate ⌥Space (global, native helper).

## Deviations from the brief

- Sleep is detected by the wall vs monotonic clock gap, not IOKit wake notifications.
- oxc is pinned to 0.152.0 (rustc 1.96.1).
- The voice sidecar is copied but not in `externalBin` yet (V7).
- Plans have no event; they re-list through the watcher.
- Webhook URLs carry the token, not the routine id.
- `routines.maxParallel` defaults to 2 (the prototype's default), not 1.
