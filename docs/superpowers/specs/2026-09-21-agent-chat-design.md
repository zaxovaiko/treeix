# Agent chat

## Goal

A chat view for Claude Code sessions, next to the terminal: messages with markdown, collapsible thinking, tool calls as
cards, permission prompts you answer with a click, images, stop, model switching with an honest cost warning, and
chats you can archive and come back to. The chat and the terminal are two views of one Claude session: either can
open the other, and the conversation continues.

## Scope

Stage 1, this spec:

- Claude chat sessions in the Terminal tab, as tabs of a group next to terminal sessions
- Streaming text and thinking, tool cards, a to-do list, subagents collapsed
- Permission prompts in the chat, and the permission mode picker (ask, accept edits, plan, bypass)
- Images by paste, drop or the attach button
- Stop, send while working (queued), slash commands with completion
- Model picker with a re-read warning and "Summarize first"
- Chat list per group with status, archive, reopen with the full history
- "Open in terminal" and back, on the same Claude session id
- Review comments and browser items land in the composer as a draft
- Settings: Claude opens as Chat or Terminal (Terminal by default), default chat model, how thinking shows

Later, not in this spec:

- Codex chat through `codex app-server` (stage 3); the setting row for Codex appears then
- Rewind and file checkpoints
- Editing or retrying a past message
- A chat outside the Terminal tab (its own top-level tab)

## User experience

- **Starting.** The group's "+" menu lists Claude, Shell, and Claude in the other view ("Claude in terminal" when chat is
  the default, "Claude chat" otherwise). ⌘T keeps opening a shell; the palette gets "New Claude chat".
- **Tabs.** A chat tab shows its title (the first message, shortened, renamable), a kind badge "Claude · chat" and the
  same status dot as terminal sessions: amber while it needs you, green while it works.
- **Feed.** Your messages right-aligned with image thumbnails. Claude's text as markdown with the app's code blocks.
  Thinking as a muted "Thought for 9s" line that expands; setting: collapsed, expanded or hidden. Tool calls as cards:
  - Read, Grep, Glob: one line with the path or pattern and a count, expandable
  - Edit, MultiEdit, Write: the file and +/- counts, with the diff inline (the app's diff renderer)
  - Bash: the command, then output collapsed after 10 lines
  - TodoWrite: the task list, updated in place
  - Task (subagents): one line per subagent, expandable to its own feed
  - WebFetch, WebSearch: the URL or query
  - Anything else: the tool name and its input as JSON, collapsed
- **Permission prompts.** A card in the feed with what Claude wants to do (command, file and diff, URL) and three
  buttons: Allow once, Allow for this chat, Deny (with an optional note sent back to Claude). Plan mode's
  ExitPlanMode arrives the same way and shows the plan as markdown with Approve and Keep planning. While a prompt
  waits the session is amber and ⌘↵ / Esc answer allow once / deny.
- **Composer.** Text with Enter to send (⇧Enter for a new line, ⌘↵ also sends), paste or drop images, "/" opens slash
  command completion from the session's command list, "@" completes files of the worktree. Under it: attach, model
  picker, permission mode, thinking toggle, context meter (tokens used of the model's window), Send or Stop.
  Messages sent while Claude works are queued and shown greyed until picked up.
- **Model switch.** Picking another model shows, before switching: "Switching re-reads the whole chat without the
  cache: about 48k tokens." with Switch, Summarize first (runs `/compact`, then switches) and Cancel. Under 10k
  tokens it switches without asking.
- **Hints.** One muted line under the composer, rotating by state: "Esc stops Claude", "⇧Tab changes permission mode",
  "Context is 80% full: /compact summarizes", "Paste a screenshot to show the problem".
- **Chat list.** The group list shows chats with the terminal sessions; closed chats go to the group's History as
  closed terminal sessions do, and "Archive" hides a chat from History without deleting the transcript. Reopening
  renders the transcript and resumes on the next message.
- **Switching view.** "Open in terminal" ends the chat's process and opens a terminal session with
  `claude --resume <id>` in the same tab slot; the terminal tab gets "Open as chat", which ends the terminal process
  and reopens the chat. One view runs at a time.

## Architecture

### Where it lives

A new plugin, `packages/plugins/chat`, with `main`, `renderer` and `shared`. The terminal plugin keeps owning groups,
tabs and session lifecycle; a session gains `view: 'terminal' | 'chat'`, and for chat sessions the terminal plugin
renders the chat plugin's view through a new `chat` service instead of xterm:

```ts
Services.chat: {
  View: ComponentType<{ sessionId: string }>
  start: (sessionId: string, options: { cwd: string; agentSessionId: string | null; model: string | null }) => Promise<void>
  stop: (sessionId: string) => void
  status: (sessionId: string) => SessionStatus
  draft: (sessionId: string, text: string) => void
  subscribe: (listener: () => void) => () => void
}
```

With the chat plugin disabled, "Claude opens as" falls back to Terminal and existing chat sessions open in the terminal.

### Main process

- Uses `@anthropic-ai/claude-agent-sdk` `query()` in streaming input mode, one `Query` per chat session, with:
  - `pathToClaudeCodeExecutable`: the user's `claude` on PATH, so their login, version and settings apply
  - `cwd`: the session's folder; `resume`: the Claude session id when continuing
  - `settingSources: ['user', 'project', 'local']`, so CLAUDE.md, hooks, MCP servers and permissions match the terminal
  - the same `--settings` the terminal passes (`TREEIX_CLAUDE_SETTINGS` from other plugins' session env)
  - `includePartialMessages: true` for streaming text and thinking
  - `canUseTool`: forwards the request to the renderer and waits for the answer
  - `model`, `permissionMode` from the chat's state
- Controls over IPC: `send(message)` pushes onto the input stream, `interrupt()`, `setModel()`, `setPermissionMode()`,
  `stop` ends the query.
- Events to the renderer are batched every 50 ms: stream deltas, whole messages, permission requests, results with
  usage, errors.
- History: `listSessions({ dir })` and `getSessionMessages(id, { dir })` read transcripts for reopening.
- The SDK's bundled Claude Code binary is not shipped: electron-builder excludes it and the executable path always
  points at the user's install. Without `claude` on PATH the chat shows the existing tool status message and offers
  Terminal.

### Renderer

- `renderer/feed.ts`: a pure reducer from SDK events to a view model: turns, blocks (text, thinking, tool with its
  result, permission request), partial deltas merged into the last block, tool results paired to tool uses by id,
  subagent messages grouped by `parent_tool_use_id`. Tested with recorded event fixtures.
- `renderer/Chat.tsx` (the `View`), `Composer.tsx`, `ToolCard.tsx`, `PermissionCard.tsx`, `ModelSwitch.tsx`.
- Markdown through the host's lazy markdown renderer; diffs through the host's diff view; file paths open in the
  Worktrees viewer like terminal file links.
- Status for the dot and keep awake: running while a turn streams, input while a permission request waits, idle after
  a result, exited on error or stop.

### Session model

- Chat sessions are stored with the terminal's saved sessions (`SessionMeta` gains `view`), so groups, tabs, History,
  restore on relaunch and workspaces work unchanged.
- The Claude session id is the link between views: new chats capture it from the SDK's init message; terminal
  sessions already pass `--session-id`.
- Transcript text is never copied into Treeix storage; Claude's own `~/.claude/projects` files are the record.

### Cost estimate

`contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the last result's usage.
The switch warning shows it rounded to thousands. "Summarize first" sends `/compact`, waits for its result, then
calls `setModel()`.

### Settings

Settings > Terminal > Agent sessions:

- Claude opens as: Chat | Terminal (default Terminal)
- Default chat model: the models the CLI reports, default "Default" (the CLI's own choice)
- Thinking: Collapsed | Expanded | Hidden (default Collapsed)

### Packaging

- New dependency `@anthropic-ai/claude-agent-sdk` (runtime, main process only), with its bundled CLI binary excluded
  from the package.
- The feature relies on the user's installed Claude Code version; the minimum is whatever supports streaming input
  and `can_use_tool` control requests, checked at start from the CLI version, with a message to update when older.

## Error handling

- CLI missing or too old: the tab shows why and a button to open the session in the terminal instead.
- Not logged in: the SDK's auth error is shown with "Run claude to sign in" opening a shell running `claude`.
- Process exits mid-turn: the turn is marked interrupted, the composer stays, the next message resumes the session.
- Permission request while the window is hidden: a system notification "Claude needs you" (same as the terminal's
  waiting state).
- Image too large (over 5 MB) or of another type: refused in the composer with the reason.

## Testing

- Unit: the feed reducer against recorded SDK event fixtures (text streaming, thinking, tool use and result pairing,
  subagents, permission requests, interrupted turns, compact); the cost estimate; image validation; slash command
  filtering.
- Manual: start a chat, approve and deny commands, plan mode approve, paste a screenshot, stop mid-turn, switch model
  with and without summarizing, archive and reopen after relaunch, open in terminal and back mid-conversation, keep
  awake and the status dot while a prompt waits.

## Risks

- Claude Code changes often. The SDK absorbs protocol changes; the view falls back to the generic tool card for
  unknown tools, and the terminal is always one click away.
- Permission parity: rules from settings files apply through `settingSources`; anything the SDK can't express stays
  a terminal feature.
- Running the user's CLI from the app is the same as the terminal doing it, but it is a new way of driving their
  subscription; if Anthropic's terms for third-party apps change, the chat can be turned off without touching the
  terminal.
- Size: the SDK package is large; excluding its binary keeps the DMG change small, checked in the release build.
