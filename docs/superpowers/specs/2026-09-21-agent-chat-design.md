# Agent chat

## Goal

A chat view for coding agents, next to the terminal: streaming messages, collapsible thinking, tool calls as cards,
permission prompts answered with a click, images, stop, model and mode switching with an honest cost warning, and
chats you can archive and come back to. It works with any CLI agent through adapters: the chat core knows nothing
about Claude or Codex, and an agent joins by naming an adapter and a command. Agents run as the user's own installed
CLIs, so each one uses its own login and subscription; Treeix holds no keys.

## Scope

Stage 1, this spec:

- The chat core: session tabs in the Terminal tab, the feed, the composer, permission cards, model and mode pickers,
  images, stop, archive and reopen, comments as drafts, settings
- The adapter interface, and adapters as a plugin contribution any plugin can add
- One built-in adapter: the Agent Client Protocol (ACP)
- Presets: Claude Code through `claude-code-acp`, Codex through `codex-acp`, Gemini CLI through `gemini --experimental-acp`
- Custom agents from Settings > Agents can set a chat command and get the chat too

Later, not in this spec:

- Native adapters where they give more than ACP (Claude Agent SDK, `codex app-server`)
- Rewind and checkpoints, editing or retrying a past message
- A chat as its own top-level tab

## Adapters

### The interface

The chat core talks to one interface, declared in `@treeix/sdk/main` so any plugin can implement it:

```ts
type ChatAdapter = {
  id: string
  label: string
  /** Starts or resumes a session; `command` is the agent's chat command from the registry */
  connect: (options: { cwd: string; command: string; env: Record<string, string>; resume: string | null }) => Promise<ChatConnection>
}

type ChatConnection = {
  sessionId: string
  capabilities: { images: boolean; load: boolean; list: boolean; usage: boolean }
  onEvent: (listener: (event: ChatEvent) => void) => () => void
  prompt: (content: ChatContent[]) => Promise<{ stopReason: StopReason }>
  cancel: () => void
  answer: (requestId: string, optionId: string | null) => void
  setOption: (id: string, value: string) => Promise<void>
  list?: (cwd: string) => Promise<{ sessionId: string; title: string; updatedAt: number }[]>
  /** Command that opens this session in a terminal, when the agent's ids match its CLI's */
  terminalCommand?: string
  close: () => void
}
```

`ChatEvent` mirrors ACP's session updates, so the ACP adapter is a thin pass-through and other adapters translate
into it:

- `message_chunk` (role user or agent, content), `thought_chunk`
- `tool_call`, `tool_call_update` (id, title, kind: read, edit, delete, move, search, execute, think, fetch, other;
  status; content: text, diff with path and old and new text, terminal output; locations)
- `plan` (entries with content, priority, status)
- `usage` (used and size in tokens, optional cost)
- `options` (the session's config options: mode, model, others, each a select with current value)
- `permission` (request id, title, description, the tool call it is about, options with kind allow_once,
  allow_always, reject_once, reject_always)
- `commands` (slash commands the agent offers), `turn_end` (stop reason), `error`

### Contribution

`MainPlugin` gains `chatAdapters?: ChatAdapter[]`. The host collects adapters from enabled plugins, as it does
tools, and the chat plugin looks them up by id. The chat plugin itself contributes the ACP adapter.

### The agent registry

`Agent` (`apps/desktop/src/renderer/src/agents.ts`) gains `chat?: { adapter: string; command: string }`:

- Claude: `{ adapter: 'acp', command: 'npx -y @zed-industries/claude-code-acp' }`
- Codex: `{ adapter: 'acp', command: 'codex-acp' }`
- Gemini (new built-in agent, terminal command `gemini`): `{ adapter: 'acp', command: 'gemini --experimental-acp' }`
- Custom agents: an optional "Chat command" field, adapter ACP

An agent without `chat` stays terminal only. Commands run through the user's login shell like terminal sessions, so
PATH, login state and the other plugins' session environment apply. Adapter binaries are not bundled; the agents page
in Settings shows whether each chat command is available, with the install command when it isn't
(`npm i -g @zed-industries/claude-code-acp`, `codex-acp` from its release page).

### The ACP adapter

- Uses the official TypeScript client from `@agentclientprotocol/sdk`: spawns the command, speaks JSON-RPC over stdio.
- `initialize` with client capabilities: file system read and write through the host (so edits land in the worktree
  the session belongs to), terminals off at first (agents run commands themselves).
- `session/new` or `session/load` when resuming and the agent supports it, `session/prompt`, `session/cancel`,
  `session/set_config_option` for mode and model, `session/list` when offered.
- Permission requests become `permission` events and wait for `answer`.

## User experience

- **Starting.** The group's "+" menu lists each agent in its default view and, below, the other view ("Claude in
  terminal" or "Claude chat"). Agents without a chat command show only the terminal entry. The palette gets
  "New <agent> chat".
- **Tabs.** A chat tab shows its title (the first message, shortened, renamable), a kind badge ("Claude · chat") and
  the status dot: amber while it needs you, green while it works.
- **Feed.** Your messages right-aligned with image thumbnails. Agent text as markdown. Thinking as a muted
  "Thought for 9s" line that expands (setting: collapsed, expanded, hidden). Tool calls as cards chosen by `kind`:
  - read, search, fetch: one line with the path, pattern or URL, expandable
  - edit, delete, move: the file and +/- counts, the diff inline (the app's diff renderer)
  - execute: the command, output collapsed after 10 lines
  - think, other: title and content, collapsed
  - Unknown shapes fall back to title plus raw input as JSON
- **Plan.** The agent's plan as a task list pinned above the composer while a turn runs, updated in place.
- **Permission prompts.** A card with the request's title, what it touches (command, file and diff, URL) and one button
  per option in the agent's order and names; an optional note goes with a reject. ⌘↵ picks the first allow option,
  Esc the first reject. While one waits the session is amber.
- **Composer.** Enter sends, ⇧Enter new line. Paste, drop or attach images when the agent accepts them (the attach
  button hides otherwise). "/" completes the agent's slash commands, "@" completes worktree files. Under it: attach,
  mode and model pickers from the session's config options, the context meter when the agent reports usage, and
  Send or Stop. Messages sent while the agent works queue and show greyed until sent.
- **Model switch.** Before switching: "Switching re-reads the whole chat without the cache" plus "about 48k tokens"
  when usage is known, with Switch, Summarize first (when the agent offers `/compact`, sent before switching) and
  Cancel. Under 10k tokens it switches without asking.
- **Hints.** One muted line under the composer by state: stop, mode switching, context over 80%, pasting screenshots.
- **Chat list and archive.** Chats sit in groups with terminal sessions and go to the group's History when closed.
  Archive hides a chat from History. Reopening resumes through `session/load` with the transcript replayed; agents
  without it offer "New chat with a summary" instead, seeded with the last visible messages.
- **Switching view.** "Open in terminal" appears when the connection gives a `terminalCommand`: it closes the chat and
  runs that command in a terminal session in the same slot. The terminal tab gets "Open as chat" for agents whose
  terminal session id the chat can resume. Only one view runs at a time.
- **Comments.** The send button and "send to session" from review comments and the browser put the text into the
  composer as a draft for chat sessions.

## Architecture

- `packages/plugins/chat`: main (connections, the ACP adapter, IPC), renderer (the view, the feed reducer, the
  composer), shared (event and content types).
- The terminal plugin keeps groups, tabs, History and restore. `SessionMeta` gains `view: 'terminal' | 'chat'`; for
  chat sessions it renders the chat plugin's view through a `chat` service:

```ts
Services.chat: {
  View: ComponentType<{ sessionId: string }>
  start: (sessionId: string, options: { cwd: string; agent: string; resume: string | null }) => Promise<void>
  stop: (sessionId: string) => void
  status: (sessionId: string) => SessionStatus
  draft: (sessionId: string, text: string) => void
  subscribe: (listener: () => void) => () => void
}
```

- Main batches events to the renderer every 50 ms. The renderer's `feed.ts` is a pure reducer from `ChatEvent`s to
  turns and blocks (chunks merged, tool calls upserted by id, permissions attached to their tool call), tested with
  recorded fixtures.
- Transcripts are not copied into Treeix; the agent's own storage is the record. Treeix stores only the session's
  meta (agent, cwd, agent session id, title, archived).
- With the chat plugin off, chat sessions open in the terminal and "opens as" settings fall back to Terminal.

## Settings

- Settings > Agents: per agent "Opens as: Chat | Terminal" (Terminal by default), its chat command (editable for
  custom agents), and the availability check.
- Settings > Terminal > Agent sessions: thinking collapsed, expanded or hidden.

## Error handling

- Chat command missing: the tab explains and offers the install command and "Open in terminal".
- Agent needs sign-in (ACP `authenticate` methods or an auth error): shown with "Sign in" running the agent's CLI in a
  terminal session.
- Process exits mid-turn: the turn is marked interrupted; the next message reconnects and resumes when supported.
- Permission request while the window is hidden: a system notification "<agent> needs you".
- Images refused when the agent lacks the image capability, over 5 MB, or of another type.

## Testing

- Unit: the feed reducer against recorded ACP fixtures (streaming, thoughts, tool call upserts with diffs, plans,
  permissions, usage, cancel); the ACP adapter's mapping with a fake agent over an in-memory stream; the cost warning
  thresholds; image validation; slash and file completion filtering.
- Manual: Claude, Codex and Gemini each: start, approve and reject, switch mode and model, paste an image, stop,
  archive, relaunch and reopen, open in terminal and back where offered, keep awake and the status dot while a
  prompt waits.

## Risks

- Adapters trail their CLIs: a new Claude Code feature shows in the chat only once `claude-code-acp` supports it. The
  terminal stays one click away, and a native adapter can be added per agent later without touching the core.
- ACP is young and has a v2; the adapter pins the SDK version and checks the agent's protocol version at `initialize`.
- Session id parity between chat and terminal is per agent and must be verified for Claude and Codex before
  `terminalCommand` is enabled for them.
- Driving a subscription through an adapter is the agent vendor's call; each preset uses the vendor's official or
  endorsed adapter, and any agent can be switched back to terminal only.
