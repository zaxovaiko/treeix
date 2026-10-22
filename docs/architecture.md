# Architecture

Treeix is a Tauri v2 app on a Rust daemon. `treeix-ptyd` owns every terminal and chat, so sessions outlive the window. The app shell is a thin client of the daemon and the home of everything that needs a window. The UI is a React webview that talks to the shell through one typed API.

Why the larger pieces are built the way they are is recorded in [the decision records](adr/README.md). Records 1-8 were written for the Electron app this one replaced; the terminal stack is [record 9](adr/0009-terminal-stack.md).

## Layout

```
crates/proto               wire protocol between the app and ptyd, and the types the webview shares
crates/ptyd                treeix-ptyd: PTYs, terminal state, chats, routines
crates/core                plain modules the app and ptyd share: git, files, pull requests, agents, tickets, MCP
apps/desktop/src-tauri     the Tauri shell (crate treeix-app): commands, events, browser panes, tray, updater
apps/desktop/src           React 19, Tailwind 4, Vite
apps/desktop/native/voice  Swift helpers for dictation and call recording
```

## The daemon

`treeix-ptyd` runs every PTY (`portable-pty`), parses each session with `alacritty_terminal`, and keeps a sequence counter and a scrollback ring per session. An attach gets an ANSI snapshot of the screen plus the seq to continue from, so a pane that reconnects, or a daemon that restarts, comes back with its scrollback. State lives in the data dir (`state.json`, `sessions/<id>.vt`); the daemon snapshots on SIGTERM and on a `Shutdown` from a newer app.

- **Socket.** A Unix socket in the data dir, mode 0600, peer uid checked. Frames are postcard behind a u32 length. `PROTO_VERSION` bumps on any incompatible change, and variants are only ever appended because postcard encodes them by index.
- **Backpressure.** Each attached channel counts unacked bytes. Past 1 MB the daemon keeps reading and parsing at full speed, stops sending that pane data, and sends a fresh snapshot once the pane catches up. A `cat` of a huge file ends at daemon speed instead of xterm's. Details in [bench/README.md](../bench/README.md).
- **Agents.** Hooks that Claude writes (`input|working|done`, the statusline JSON) land in `$TREEIX_AGENT_STATUS`; the daemon maps them to the status dots and reads Codex off its screen. Chats are Agent Client Protocol processes (`agent-client-protocol`) run by the daemon, so they survive restarts like terminals do.
- **Routines.** The daemon runs scheduled, event and webhook routines as sessions, with budgets and a queue. The webhook listener binds 127.0.0.1 only.
- **Lifecycle.** The app connects first and starts a daemon only when nothing answers: a LaunchAgent on macOS, a systemd user unit on Linux, a plain spawn in dev. [docs/next/daemon.md](next/daemon.md).

## The app shell

`apps/desktop/src-tauri` connects to the daemon in `daemon.rs`, reconnects with backoff, and exposes everything to the webview.

- **Commands and bindings.** Each command in `commands/*.rs` (git, files, history, prs, agents, chat, mcp, tickets, routines, browser, plans, graph, voice, settings, system) is registered with `tauri-specta` in `lib.rs`. `cargo test -p treeix-app export_bindings` writes `src/ipc/bindings.ts`; never edit it by hand. Errors cross the boundary as strings.
- **Streams.** Terminal output reaches a pane over one Tauri `Channel` of raw frames, coalesced to 5 ms or 64 KB, with acks coming from xterm's write callback. The app fans one daemon attach out to every pane showing the session. Other updates are typed events (`collect_events!`).
- **Subprocesses, not libraries.** `git`, `gh`, `glab`, `acli`, `claude` and `codex` run with your own accounts. Long work runs in `spawn_blocking`, and path commands refuse paths outside their place.
- **Browser panes.** One child webview per pane (`Window::add_child`, Tauri's `unstable` feature; `browser/` is the only user of it). An injected script reports console and network rows and serves the agent tools; cookie import copies from Chromium browsers, Firefox and Safari.
- **MCP server.** `core::mcp` serves the agents Treeix runs over streamable HTTP on 127.0.0.1 with a bearer token. Browser tools show up in it only while the browser feature and its agent switch are on.
- **The rest.** The quick terminal (a panel under a global shortcut), tray and menu, keep-awake, the updater ([docs/next/updater.md](next/updater.md)), and the voice sidecars: the two Swift helpers ship as `externalBin` and speak JSON lines over stdin and stdout.

## Core modules

`crates/core` has no UI and no Tauri: `places` (the checkout or folder behind a cwd), `git`, `fs` (with watching and conflict-checked saves), `search`, `history` (file snapshots, closed sessions), `prs`, `agents` (hooks, transcripts, Codex rollouts, ports, token usage, plan limits), `tickets` (Jira through `acli`, Notion), `mcp`, `routines`, `plans`, `graph` ([notes](next/graph.md)), `settings` and `secrets` (OS keyring, a 0600 file where none answers).

## The webview

`src/ipc/api.ts` is the one surface the UI talks to. `tauri.ts` implements it over commands and channels; `mock.ts` implements it in memory, so `bun run dev` works in a plain browser with seeded sessions and the Playwright tests run without a window.

```
shell/      window chrome, panes and splits, palette, shortcuts, session state
panes/      terminal (xterm.js 6), chat, file view (Monaco, diffs)
panels/     Changes, Explorer, History, pull requests
dialogs/    worktrees, branches, find in files, file history
pages/      Settings
features/   agents, browser, graph, mcp, plans, routines, tickets, voice
```

- **Features are switches.** `features.ts` lists them; one that is off in `settings.features` does no work and its UI is hidden.
- **Hidden terminals cost nothing.** A pane that is not on screen disposes its xterm and WebGL context and re-attaches from a snapshot when shown.
- **Settings** live in `<data dir>/settings.json`. The app writes the file; ptyd only reads the terminal fields. Secrets never reach the webview.

## Tests

Rust tests sit beside the code, and `crates/ptyd/tests` start a daemon in process on a temp socket. Frontend logic worth testing is a plain module with a `*.test.ts` beside it. Playwright runs the UI against the mock in WebKit and Chromium, and an in-app runner (`TREEIX_AUTORUN=e2e`) drives the real app and daemon. [docs/next/testing.md](next/testing.md) has the commands.
