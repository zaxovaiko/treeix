# Phase 4-5 contract: agents, chat, MCP, tickets, settings

The shared surface the Phase 4-5 agents build against. The UI talks to `Api` in `apps/desktop/src/ipc/api.ts` only. `tauri.ts` maps it to the generated commands. The mock implements it in memory: `mockAgents.ts`, `mockChat.ts` and `mockSettings.ts`, spread into `mock.ts`.

- Rust commands live in `apps/desktop/src-tauri/src/commands/{agents,chat,mcp,tickets,settings,system}.rs`. All are registered in `lib.rs`. Each stub returns `Err("not implemented")` until its owner fills it in.
- `get_settings` and `update_settings` already work.
- Types:
  - Chat types are in `crates/proto/src/chat.rs`: shared by ptyd and the app, with specta behind the proto `specta` feature.
  - The rest are in `crates/core/src/{agents,mcp,tickets,secrets,settings}` and the command files.
  - `api.ts` re-exports the Phase 4-5 types from `bindings.ts` instead of mirroring them by hand. Change the Rust type, regenerate, and update the mock: `CARGO_TARGET_DIR=... cargo test -p treeix-app export_bindings`.
- Proto is at version 3:
  - New variants were appended to `SessionStatus` (`Watching`), `Request`, `Response` and `Event`. Never reorder: postcard encodes by index.
  - Tagged chat enums travel as JSON strings inside the postcard frames (`chat::as_json`), because postcard cannot encode internally tagged enums.

## Rules for every command

- The Phase 3 rules apply: subprocesses for git, gh, glab, acli, claude and codex; String errors; no `unwrap` on external input; long work in `spawn_blocking`.
- Secrets never reach the UI or the logs. `hasSecret` is the only read. The Notion token sits in the keyring; on Linux without a secret service it falls back to a 0600 file in the data dir (`core::secrets`).
- Settings live in `<data dir>/settings.json`. The app writes the file and ptyd only reads it. The ui state blob (`getUi`/`putUi`: theme mode, density, orientation, quick shortcut) stays where it is.
- A feature that is off (`settings.features.<id>`) does no work: no polling, no watcher, no MCP listener. Its UI is hidden too (see Features).

## Surface

### Agents (A3: `core::agents`, ptyd `hooks.rs`, `commands/agents.rs`)

- Status dots
  - ptyd sets `TREEIX_AGENT_STATUS=<data dir>/agent-status` on every session.
  - Claude's hooks write `input|working|done` to `<dir>/<TREEIX_SESSION>` and the statusline JSON to `usage-<TREEIX_SESSION>`.
  - ptyd `hooks::watch` maps them to `needs|running|done`. It sets `watching` when a turn ended with background work, read from the screen footer.
- `prepare_agent` (commands/agents.rs) runs inside `create` for claude and codex sessions. It adds:
  - the hook settings (`core::agents::hooks::with_status_hooks`)
  - the skip-permission flags from `settings.agents`
  - the MCP env (`mcp::agent_env`)

  The frontend still composes the base command (`AGENT_COMMAND` in Shell.tsx).
- Agent session ids
  - Claude: ptyd reads it from the hook payload and broadcasts `Event::AgentSession`.
  - Codex: the app finds the rollout (`core::agents::codex`) and sends `Request::SetAgentSession`, which is already implemented in ptyd.
  - The UI gets `SessionEvent { type: 'agentSession' }` and `SessionInfo.agentSession`.
- `SessionRecord.messages / cost / firstPrompt`: A3 fills them from the transcript when the session record is written.
- `agentUsage()` returns rows per day, agent, model, project and session, from Claude transcripts and Codex rollouts.
  - Cache the parsed files by mtime in the cache dir.
  - `prices` are $ per million tokens: [input, output, cacheRead, cacheWrite]. `titles` are by session id.
- `usageLimits()` returns the 5 h and weekly windows per agent: Claude from the statusline file, Codex from the latest rollout. `onUsageLimits` fires when they change.
- `sessionUsage(session)` returns the tokens and cost of one session's conversation, or null without an agent session.
- `sessionPorts()` lists TCP listeners in each session's process tree (`lsof` + `ps`, a port of ports.ts).
- `killPort(port, pid)` refuses when that pid no longer listens on the port.

### Chat (A4: ptyd `chat/`, `commands/chat.rs`, routing in `daemon.rs`)

- Chats run in ptyd over ACP (`agent-client-protocol` 3.4), so they survive an app restart like PTY sessions.
  - ptyd keeps one log per chat as `ChatEntry { seq, at, event }`, with seq from 0.
  - The log persists with the daemon state.
- `chatCreate(NewChat)`
  - The app turns `NewChat` into `Request::ChatCreate`: adapter command, env (MCP, skip flags), resume id and preset.
  - The chat starts `starting`, then becomes `idle`.
- `chatPrompt(chat, content)`: a `disconnected` chat restarts its agent first and resumes the conversation.
- `chatCancel` ends the turn with `turn_end { stopReason: 'cancelled' }` and settles open permissions.
- `chatAnswer(chat, requestId, optionId | null)`: null rejects. Every window sees `permission_settled`.
- `chatSetOption(chat, optionId, value)`: the agent answers with a new `options` event.
- `chatList()`: the live chats.
- `chatAttach(chat, fromSeq, onEntry)`
  - Replays the log from `fromSeq`, then streams live entries in seq order, then resolves with `{ info, detach }`.
  - The app routes `Event::Chat` to each attached channel, drops entries below what the channel has seen, and sends `ChatDetach` when the last channel of a chat leaves.
  - A view re-attaching after a reload passes the last seq it rendered + 1.
- `chatClose(chat)` stops the agent and drops the log. The conversation stays resumable from History via `agentSession`.
- `onChats` reports `changed { info }` (status, title, agent session) and `removed { chat }` across windows.
- Event semantics (the `ChatEvent` union, snake_case tags as in Electron's acpEvents):
  - `message_chunk` / `thought_chunk`: append to the current message of that role. `parent` is the tool call whose subagent produced it.
  - `tool_call`, then `tool_call_update { id, patch }`: null fields in `patch` keep the old value. A `diff` output with `oldText: null` is a new file.
  - `permission`: chat status becomes `needs`. `permission_settled` ends it.
  - `turn_start` / `turn_end`; `usage` is the context window (`used` of `size`); `title`, `options`, `commands`.
  - `error` is shown inline. `disconnected` means the agent process ended.

### MCP (A5: `core::mcp`, `commands/mcp.rs`)

- rmcp streamable HTTP on axum, bound to `127.0.0.1:0`. One random token per app run.
  - Every request must carry `Authorization: Bearer <token>`, checked with `core::mcp::token_matches` (constant time, already implemented and tested).
  - `mcp::start` runs in setup when `features.mcp` is on.
- Agents get `TREEIX_MCP_URL` and `TREEIX_MCP_TOKEN` through `agent_env`.
- `mcpStatus()`: running, url, per-agent install state (`installed | outdated | missing`), and the tool list.
- `mcpInstall()` registers the server with Claude (`claude mcp add`) and Codex (`~/.codex/config.toml`). It returns what worked and what failed. This drives the MCP setup dialog.
- Tools: open a file at a line, open a worktree, list sessions, ask a question in the UI. Their handlers go through the same paths as the UI (`ShellView.openFile`, `addWorktree`).

### Tickets (A5: `core::tickets`, `commands/tickets.rs`)

- `myTickets()` merges Jira and Notion. Each source runs only when its feature is on.
  - Jira: `acli jira workitem search --jql <settings.jira.jql> --json`.
  - Notion: the API, with the keyring token and `settings.notion.database`.
  - A failing source lands in `errors` while the other still lists.
- `ticketDetail(source, key)` returns the description as markdown, quoted in the agent's first prompt. `acli::checked_key` rejects keys that are not `[A-Z][A-Z0-9]+-\d+`.
- `notionDatabases()` lists the databases the token can see, for Settings > Notion.

### Settings (U6: `core::settings` done, `commands/settings.rs`)

- `getSettings()`. `updateSettings(patch)` takes any subset, one section deep (`{ terminal: { fontSize: 13 } }`).
  - The merge is deep, unknown fields are dropped, and a type error rejects without writing.
  - The write is atomic. `onSettings` then fires in every window.
- `hasSecret / setSecret / deleteSecret` (`'notionToken'`) go through `core::secrets` (keyring 4: `keyring::Entry::new(SERVICE, account)`).
- `keys` holds shortcut overrides: action id to accelerator, with `''` unbinding. Check conflicts against `shell/shortcuts.ts`, `panes/terminal/keys.ts`, `useDialogKeys` and the panel keys.

### System (U6: `commands/system.rs`)

- `cliTools()`: claude, codex, acli, gh and glab, each with version, sign-in and account. Run them in parallel with a 3 s timeout each.
- `appVersion()`
- `checkUpdate()` / `installUpdate()` use `tauri-plugin-updater` 2.14. The plugin is in Cargo.toml but not registered yet.
  - U6 adds `.plugin(tauri_plugin_updater::Builder::new().build())`, the `plugins.updater` config (endpoint and pubkey) and the capability.
- `keepAwake()` / `setKeepAwake(on)` / `onKeepAwake`
  - macOS uses `IOPMAssertionCreateWithName` (`objc2-io-kit` `pwr_mgt`); Linux uses `systemd-inhibit`.
  - With `untilAgentsFinish`, `active` follows whether any agent session is running.
- The tray (`tauri` `tray-icon` feature) is built in `system::setup`. Its label comes from `settings.usage.tray` and the limits; `off` removes the icon.

## Features

- `apps/desktop/src/features.ts`
  - `FEATURES`: id (a `settings.features` key), label, description, and the settings sections the feature owns.
  - `SETTINGS_NAV` and `sectionVisible`.
  - `THEMES`: name, --background and --primary. --popover is derived as in the prototype.
  - `DEFAULT_SETTINGS`: mirrors the Rust defaults.
- A feature that is off hides its settings sections, panels, palette actions and status items. Each UI owner gates their contributions on `settings.features.<id>`.
- `race` and `ports` have no settings section.

## Not in this contract

- Multi-agent race needs no new API. U5 builds it from `addWorktree` + `create`:
  - one worktree per agent at `<ticket branch>-<agent>`
  - optional shell split
  - "draft PR when done" as a shell command when the session turns `done`
- Ticket branch names are computed in the UI: `fix/` for bugs, `feat/` otherwise, then `<key lower>-<4-word slug without stopwords>`.
- Phase 7 items stay out: browser, voice, meetings and the plugin store. The prototype's Tools > browser/voice/meetings and More > plugins are left out. More > Features lists the toggles instead.
- Markdown in chat and ticket detail uses `react-markdown` 10.1, `remark-gfm` 4.0.1, `rehype-raw` 7 + `rehype-sanitize` 6, and `shiki` (already present). Mermaid waits.

## Who implements what

- A3, agents core
  - `crates/core/src/agents/*` (hooks, transcripts, codex, usage, limits, ports)
  - ptyd `hooks.rs`
  - `commands/agents.rs`, including `prepare_agent` and the History record stats
  - Port the tests of hooks, transcripts, codex, usage and limits.
- A4, chat backend
  - ptyd `chat/` (ACP client, log, persistence, replay)
  - `commands/chat.rs` and its `on_chat_event` routing
  - Port the acpEvents tests.
- A5, integrations
  - `core::mcp`, `core::tickets`, `core::secrets`
  - `commands/{mcp,tickets}.rs`
  - Port the acli and notion tests.
- U4, the chat pane: messages, tool calls with diffs, permission prompts, the plan, the options bar, slash commands and the composer. "Open as chat" for agent sessions.
- U5, the agent UI:
  - status dots including watching
  - the usage pill and popover, the ports popover
  - "Your tickets" in Open worktree, the race
  - the MCP setup dialog
- U6, Settings and system:
  - the Settings page with every section, the hotkey recorder, theme tokens
  - the updater (registration and config), keep awake, the tray
  - `commands/{settings,system}.rs`

The UI agents work against the mock: `?seed=empty` for first run. The seeded data includes:
- a chat waiting on a permission
- a `watching` session (s7)
- usage, limits and ports
- Jira and Notion tickets, which need the features on

## UI placement (from the prototype)

- Title bar: the usage pill (`settings.usage.window`). Clicking it opens the popover with both windows per agent and tokens by day / model / project from `agentUsage`.
- Status bar: the ports item (count). Its popover lists port, process and session, with Open in browser and Kill. There is also the keep-awake toggle.
- Sidebar dots: run, need, done, watching (a run-style dot), err, exit. Agent tabs show cost from `sessionUsage`.
- New chat: hovering the new-session button offers shell / Claude / Codex; `chats.defaultView` picks terminal or chat for agents.
  - The chat pane is a page tab with the message column at `chats.width`.
  - The composer has model / effort / mode from `options`, and slash commands from `commands`.
  - A permission shows as a card with its options. Thinking is folded and hidden when `showThinking` is off.
- Open worktree dialog: a "Your tickets" list above the branch picker (Jira and Notion icons, key, title, status).
  - Picking a ticket fills the branch and the first prompt.
  - The race toggle asks for agents and shows "Racing two agents needs a worktree each" and "Create N worktrees".
  - Options: "Open a shell split beside the agent", "Open a draft PR when the agent finishes".
- Settings (⌘,), a page tab with search over every row:
  - App: Appearance (mode, dark / light theme grids), Terminal, Keys (recorder per action), Hotkey (quick terminal ⌃`).
  - Agents: Agents (CLI tools, skip permissions), Chats, Usage (pill, window, tray), MCP (status, Install).
  - Integrations: Jira (acli sign-in, JQL), Notion (token, database), Pull requests (refresh).
  - Tools: Keep awake (mode, lid closed).
  - More: Features (one switch each), About ("Check for updates", then "<version> is ready", then "Restart and install").
- Keys from the prototype: New shell ⌘T, New Claude ⇧⌘C, New Codex ⇧⌘X, Open worktree ⇧⌘N, Palette ⌘K, Settings ⌘, and Quick terminal ⌃`.
