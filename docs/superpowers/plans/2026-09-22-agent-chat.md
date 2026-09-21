# Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat view for any CLI coding agent, next to its terminal, driven through pluggable adapters, with the Agent Client Protocol as the built-in adapter and Claude, Codex and Gemini as presets.

**Architecture:** `@treeix/sdk` declares the adapter contract and the `ChatEvent` model. Plugins contribute adapters through `MainPlugin.chatAdapters`; the host collects them. A new `chat` plugin owns connections in main (including the ACP adapter), and the chat view, feed reducer and composer in the renderer. The terminal plugin keeps groups, tabs and history; its sessions gain `view: 'terminal' | 'chat'` and it renders chat panes through the `chat` service.

**Tech Stack:** Electron 39, React 19, Tailwind 4, `@agentclientprotocol/sdk` 1.5 (ESM, main process), `@pierre/diffs` (already a dependency), Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-21-agent-chat-design.md`

## Global Constraints

- TypeScript: never `any`. `unknown` only at trust boundaries (ACP messages, IPC payloads, JSON), narrowed. `as const` over `enum`.
- Minimal but production-ready; no speculative abstractions beyond the adapter contract the spec asks for.
- Never use em or en dashes anywhere. UI copy sentence case, no "please".
- Conventional commits, no AI attribution lines. Never push.
- Plugins never import each other; they talk through `host.service(name)` and SDK contracts.
- Agents run as the user's own CLIs through their login shell; Treeix holds no keys and bundles no adapter binaries.
- "Opens as" defaults to Terminal for every agent.
- Before each commit: `bun run typecheck`, `bun test`, `bunx oxlint packages apps/desktop/src` (old warnings fine), and `cd apps/desktop && bunx electron-vite build` when main or build inputs changed.
- Tests are Bun, colocated, for pure modules and for the ACP adapter over in-memory streams (no Electron, no DOM).

## Rulings on the spec

1. Chat and terminal sessions share the terminal plugin's store as a discriminated union on `view`, rather than a second store: groups, tabs, History, restore and workspaces then work for both without duplication.
2. Tool diffs render with `@pierre/diffs/react` `MultiFileDiff` and the host's `codeThemeOptions()` / `diffBackground()` from `@treeix/app/FileView`, the same way `HistoryDialog.tsx` does.
3. "@" file completion reads `window.api.listFiles(worktreePath)`, which the Worktrees file finder already uses.
4. ACP `terminal` client capability stays off; agents run commands themselves. File system capabilities are on and confined to the session's folder and the user's home.
5. "Open in terminal" is enabled only when the adapter reports `terminalCommand`; the ACP adapter reports it for no agent in this plan (spec risk: id parity unverified). The button and menu entry exist and appear once an adapter provides it.

## File structure

```
packages/sdk/src/chat.ts                    ChatEvent, ChatContent, ChatAdapter, ChatConnection types
packages/sdk/src/main.ts                    MainPlugin.chatAdapters, MainContext.chatAdapter(id)
packages/sdk/src/index.ts                   re-export chat types, Services.chat, SessionSummary.view
apps/desktop/src/main/plugins.ts            collect adapters from enabled plugins
apps/desktop/src/renderer/src/agents.ts     Agent.chat, Gemini preset, chat presets for Claude and Codex
apps/desktop/src/renderer/src/settings.ts   agentViews, chatThinking settings; parse chat on custom agents
packages/plugins/chat/
  package.json
  shared/types.ts                           IPC payloads between chat main and renderer
  main/acpEvents.ts (+ test)                ACP session updates and permission requests to ChatEvents
  main/acpAdapter.ts (+ test)               the ACP ChatAdapter over a child process
  main/shell.ts                             spawn a command through the login shell
  main/index.ts                             connections per chat session, IPC, batching
  renderer/feed.ts (+ test)                 ChatEvents to turns and blocks, pure
  renderer/composer.ts (+ test)             image validation, slash and file completion, switch warning, pure
  renderer/store.ts                         per-session feed, status, options, pending prompts
  renderer/Chat.tsx                         the View: feed, plan, permission cards, composer
  renderer/Blocks.tsx                       message, thought, tool card, diff, permission card
  renderer/Composer.tsx                     input, attachments, pickers, meter, hints, queue
  renderer/index.tsx                        plugin: chat service, settings page
packages/plugins/terminal/renderer/terminals.ts   Session union, chat sessions, view switching
packages/plugins/terminal/renderer/TerminalPanel.tsx  render chat panes, "+" menu entries
packages/plugins/terminal/renderer/index.tsx      palette commands, sendText to chats
apps/desktop/src/renderer/src/SettingsView.tsx    Agents: opens as, chat command, availability
docs/architecture.md                              chat plugin paragraph
```

---

### Task 1: Chat contract in the SDK and adapter collection

**Files:**
- Create: `packages/sdk/src/chat.ts`
- Modify: `packages/sdk/src/main.ts`, `packages/sdk/src/index.ts`
- Modify: `apps/desktop/src/main/plugins.ts`
- Test: `apps/desktop/src/main/plugins.test.ts` (create if missing)

**Interfaces:**
- Produces: all types below, exported from `@treeix/sdk` (types only) and `@treeix/sdk/main`; `MainPlugin.chatAdapters?: ChatAdapter[]`; `MainContext.chatAdapter: (id: string) => ChatAdapter | null`; `enabledChatAdapters(): ChatAdapter[]` in `apps/desktop/src/main/plugins.ts`.

- [ ] **Step 1: The types**

`packages/sdk/src/chat.ts` (no runtime imports, so both processes can import it):

```ts
export type ChatText = { type: 'text'; text: string }
export type ChatImage = { type: 'image'; mimeType: string; data: string }
export type ChatContent = ChatText | ChatImage

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ToolOutput =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export type ToolCall = {
  id: string
  title: string
  kind: ToolKind
  status: ToolStatus
  output: ToolOutput[]
  locations: { path: string; line: number | null }[]
  rawInput: unknown
}

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }

export type ChatOption = { id: string; name: string; category: 'mode' | 'model' | 'other'; currentValue: string; values: { value: string; name: string; description: string | null }[] }

export type PermissionOption = { id: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type ChatEvent =
  | { type: 'message_chunk'; role: 'user' | 'agent'; content: ChatContent }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; id: string; patch: Partial<Omit<ToolCall, 'id'>> }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'usage'; used: number; size: number; cost: { amount: number; currency: string } | null }
  | { type: 'options'; options: ChatOption[] }
  | { type: 'commands'; commands: { name: string; description: string }[] }
  | { type: 'permission'; requestId: string; title: string; toolCallId: string | null; options: PermissionOption[] }
  | { type: 'permission_settled'; requestId: string }
  | { type: 'turn_start' }
  | { type: 'turn_end'; stopReason: StopReason }
  | { type: 'error'; message: string }

export type ChatCapabilities = { images: boolean; load: boolean; list: boolean }

export type ChatSessionInfo = { sessionId: string; title: string; updatedAt: number }

export type ChatConnection = {
  sessionId: string
  capabilities: ChatCapabilities
  onEvent: (listener: (event: ChatEvent) => void) => () => void
  prompt: (content: ChatContent[]) => Promise<{ stopReason: StopReason }>
  cancel: () => void
  /** `optionId` null cancels the request */
  answer: (requestId: string, optionId: string | null) => void
  setOption: (id: string, value: string) => Promise<void>
  list?: (cwd: string) => Promise<ChatSessionInfo[]>
  /** Command that opens this session in a terminal, when the agent's ids match its CLI's */
  terminalCommand?: string
  close: () => void
}

export type ChatAdapter = {
  id: string
  label: string
  /** Starts, or resumes when `resume` is set; `command` is the agent's chat command from the registry */
  connect: (options: { cwd: string; command: string; env: Record<string, string>; resume: string | null }) => Promise<ChatConnection>
}
```

- [ ] **Step 2: Wire into the SDK**

`packages/sdk/src/main.ts`: `import type { ChatAdapter } from './chat'`, re-export `export type * from './chat'`, add to `MainPlugin`:

```ts
  /** Chat adapters this plugin offers; the chat plugin connects agents through them by id */
  chatAdapters?: ChatAdapter[]
```

and to `MainContext`:

```ts
  /** An adapter contributed by any enabled plugin */
  chatAdapter: (id: string) => ChatAdapter | null
```

`packages/sdk/src/index.ts`: `export type * from './chat'`.

- [ ] **Step 3: Failing test for collection**

In `apps/desktop/src/main/plugins.ts`, `MAIN_PLUGINS` comes from `import.meta.glob`, which Bun doesn't evaluate; extract the pure part and test that:

```ts
// apps/desktop/src/main/plugins.test.ts
import { expect, test } from 'bun:test'
import type { ChatAdapter } from '@treeix/sdk/main'
import { adaptersOf } from './pluginAdapters'

const adapter = (id: string): ChatAdapter => ({ id, label: id, connect: () => Promise.reject(new Error('unused')) })

test('adaptersOf takes enabled plugins in order and keeps the first adapter per id', () => {
  const plugins = new Map([
    ['chat', { chatAdapters: [adapter('acp')] }],
    ['other', { chatAdapters: [adapter('acp'), adapter('native')] }],
    ['off', { chatAdapters: [adapter('ghost')] }]
  ])
  expect(adaptersOf(plugins, ['chat', 'other']).map((entry) => entry.id)).toEqual(['acp', 'native'])
})
```

Run: `bun test apps/desktop/src/main/plugins.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

`apps/desktop/src/main/pluginAdapters.ts`:

```ts
import type { ChatAdapter, MainPlugin } from '@treeix/sdk/main'

/** Adapters of the enabled plugins, first one wins per id */
export function adaptersOf(plugins: Map<string, Pick<MainPlugin, 'chatAdapters'>>, enabled: string[]): ChatAdapter[] {
  const adapters = enabled.flatMap((id) => plugins.get(id)?.chatAdapters ?? [])
  return adapters.filter((adapter, index) => adapters.findIndex((other) => other.id === adapter.id) === index)
}
```

In `plugins.ts`: `export const enabledChatAdapters = (): ChatAdapter[] => adaptersOf(MAIN_PLUGINS, [...active.keys()])`, and in `activate`'s context `chatAdapter: (id) => enabledChatAdapters().find((adapter) => adapter.id === id) ?? null`.

Run the test → PASS. Then `bun run typecheck && bun test && bunx oxlint apps/desktop/src packages/sdk`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk apps/desktop/src/main
git commit -m "feat(sdk): chat adapter contract and adapter collection"
```

---

### Task 2: Agents gain a chat command and a default view

**Files:**
- Modify: `apps/desktop/src/renderer/src/agents.ts`
- Modify: `apps/desktop/src/renderer/src/settings.ts`
- Test: `apps/desktop/src/renderer/src/agents.test.ts` (create or extend), `settings` parse test if one exists

**Interfaces:**
- Produces: `Agent.chat?: { adapter: string; command: string }`; built-in `gemini`; `agentView(agent: Agent): 'chat' | 'terminal'`; settings `agentViews: Record<string, 'chat' | 'terminal'>` and `chatThinking: 'collapsed' | 'expanded' | 'hidden'`.

- [ ] **Step 1: Failing tests**

```ts
// apps/desktop/src/renderer/src/agents.test.ts
import { expect, test } from 'bun:test'
import { BUILTIN_AGENTS, viewFor } from './agents'

test('presets carry ACP chat commands and Gemini is built in', () => {
  expect(BUILTIN_AGENTS.claude.chat).toEqual({ adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp' })
  expect(BUILTIN_AGENTS.codex.chat).toEqual({ adapter: 'acp', command: 'npx -y @zed-industries/codex-acp' })
  expect(BUILTIN_AGENTS.gemini.chat).toEqual({ adapter: 'acp', command: 'gemini --experimental-acp' })
  expect('chat' in BUILTIN_AGENTS.shell).toBe(false)
})

test('viewFor defaults to terminal and never picks chat for an agent without a chat command', () => {
  expect(viewFor(BUILTIN_AGENTS.claude, {})).toBe('terminal')
  expect(viewFor(BUILTIN_AGENTS.claude, { claude: 'chat' })).toBe('chat')
  expect(viewFor(BUILTIN_AGENTS.shell, { shell: 'chat' })).toBe('terminal')
})
```

Run → FAIL.

- [ ] **Step 2: Implement**

In `agents.ts`:
- `Agent` gains `/** Chat through an adapter; agents without it are terminal only */ chat?: { adapter: string; command: string }`.
- `claude` gets `chat: { adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp' }`, `codex` gets `chat: { adapter: 'acp', command: 'npx -y @zed-industries/codex-acp' }`.
- New built-in between codex and shell: `gemini: { id: 'gemini', label: 'Gemini', mark: '✦', color: '#4f8cf7', command: 'gemini', promptFlag: '-i', agent: true, chat: { adapter: 'acp', command: 'gemini --experimental-acp' } }` (check `gemini --help` for the interactive prompt flag; `-i` is `--prompt-interactive` in current releases).
- Add:

```ts
/** How an agent opens by default: the user's choice when it has a chat command, else the terminal */
export const viewFor = (agent: Agent, views: Record<string, 'chat' | 'terminal'>): 'chat' | 'terminal' =>
  agent.chat && views[agent.id] === 'chat' ? 'chat' : 'terminal'
```

In `settings.ts`: `Settings` gains `agentViews: Record<string, 'chat' | 'terminal'>` (default `{}`) and `chatThinking: 'collapsed' | 'expanded' | 'hidden'` (default `'collapsed'`), parsed defensively in `load()`. `parseCustomAgents` reads an optional `chat` object `{ adapter, command }` when both are strings.

Run tests → PASS; typecheck, lint.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(agents): chat commands, Gemini preset and per-agent default view"
```

---

### Task 3: ACP events to ChatEvents

**Files:**
- Create: `packages/plugins/chat/package.json`, `packages/plugins/chat/main/acpEvents.ts`, `packages/plugins/chat/main/acpEvents.test.ts`
- Modify: `apps/desktop/package.json` (dependency `@agentclientprotocol/sdk@1.5.0`)

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `fromSessionUpdate(update: unknown): ChatEvent[]`, `fromPermissionRequest(requestId: string, params: unknown): ChatEvent | null`, `toPromptBlocks(content: ChatContent[]): unknown[]` (ACP ContentBlock array), `optionsFrom(response: unknown): ChatOption[]`.

- [ ] **Step 1: Manifest and dependency**

`packages/plugins/chat/package.json`:

```json
{
  "name": "@treeix/plugin-chat",
  "version": "0.1.0",
  "private": true,
  "treeix": {
    "id": "chat",
    "name": "Chat",
    "description": "Chat view for Claude, Codex, Gemini and any agent with a chat command, next to their terminals.",
    "enabledByDefault": true
  }
}
```

Run: `cd apps/desktop && bun add @agentclientprotocol/sdk@1.5.0`. Check it lands in `dependencies` (runtime, main process).

- [ ] **Step 2: Failing tests**

`acpEvents.test.ts` (literal ACP payloads, shapes from `@agentclientprotocol/sdk` 1.5 `schema/types.gen.d.ts`):

```ts
import { expect, test } from 'bun:test'
import { fromPermissionRequest, fromSessionUpdate, optionsFrom, toPromptBlocks } from './acpEvents'

test('message and thought chunks', () => {
  expect(fromSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } })).toEqual([{ type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Hi' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix it' } })).toEqual([{ type: 'message_chunk', role: 'user', content: { type: 'text', text: 'Fix it' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } })).toEqual([{ type: 'thought_chunk', text: 'Hmm' }])
})

test('tool calls with diffs, and updates as patches', () => {
  const [call] = fromSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Edit Pricing.tsx',
    kind: 'edit',
    status: 'pending',
    content: [{ type: 'diff', path: '/repo/Pricing.tsx', oldText: 'a', newText: 'b' }],
    locations: [{ path: '/repo/Pricing.tsx', line: 3 }],
    rawInput: { file_path: '/repo/Pricing.tsx' }
  })
  expect(call).toEqual({
    type: 'tool_call',
    call: { id: 't1', title: 'Edit Pricing.tsx', kind: 'edit', status: 'pending', output: [{ type: 'diff', path: '/repo/Pricing.tsx', oldText: 'a', newText: 'b' }], locations: [{ path: '/repo/Pricing.tsx', line: 3 }], rawInput: { file_path: '/repo/Pricing.tsx' } }
  })
  expect(fromSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })).toEqual([
    { type: 'tool_call_update', id: 't1', patch: { status: 'completed', output: [{ type: 'text', text: 'ok' }] } }
  ])
})

test('plan, usage, commands, options and unknown updates', () => {
  expect(fromSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] })).toEqual([{ type: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] }])
  expect(fromSessionUpdate({ sessionUpdate: 'usage_update', used: 48000, size: 200000, cost: { amount: 0.04, currency: 'USD' } })).toEqual([{ type: 'usage', used: 48000, size: 200000, cost: { amount: 0.04, currency: 'USD' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Summarize' }] })).toEqual([{ type: 'commands', commands: [{ name: 'compact', description: 'Summarize' }] }])
  expect(fromSessionUpdate({ sessionUpdate: 'something_new' })).toEqual([])
  expect(fromSessionUpdate(null)).toEqual([])
})

test('config options and legacy modes both become options', () => {
  expect(
    optionsFrom({
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet', description: 'Faster' }] }]
    })
  ).toEqual([{ id: 'model', name: 'Model', category: 'model', currentValue: 'opus', values: [{ value: 'opus', name: 'Opus', description: null }, { value: 'sonnet', name: 'Sonnet', description: 'Faster' }] }])
  expect(optionsFrom({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } })).toEqual([
    { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'ask', values: [{ value: 'ask', name: 'Ask', description: null }, { value: 'code', name: 'Code', description: null }] }
  ])
})

test('permission requests keep option order and the tool call link', () => {
  expect(
    fromPermissionRequest('r1', {
      toolCall: { toolCallId: 't1', title: 'Run bun test' },
      options: [
        { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'd', name: 'Reject', kind: 'reject_once' }
      ]
    })
  ).toEqual({ type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }, { id: 'd', name: 'Reject', kind: 'reject_once' }] })
})

test('prompt blocks', () => {
  expect(toPromptBlocks([{ type: 'text', text: 'Hi' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }])).toEqual([
    { type: 'text', text: 'Hi' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' }
  ])
})
```

Newer permission requests carry `title` and `subject.toolCall` instead of `toolCall`; the mapper reads `params.title ?? params.toolCall.title ?? params.subject.toolCall.title` and the tool call id from either place. Add one more case for that shape once the mapper handles it.

Run → FAIL.

- [ ] **Step 3: Implement `acpEvents.ts`**

Pure, defensive readers (`record`, `text`, `list`, `num`) like `packages/plugins/browser/main/entries.ts`. Mapping:

- `user_message_chunk` / `agent_message_chunk` → `message_chunk` with content text or image (skip other content types)
- `agent_thought_chunk` → `thought_chunk` with the text
- `tool_call` → `tool_call` with defaults `kind 'other'`, `status 'pending'`, `output []`, `locations []`
- `tool_call_update` → `tool_call_update` with only the present fields in `patch` (null fields skipped)
- tool content: `{type:'content', content:{type:'text'}}` → text, image likewise, `{type:'diff'}` → diff, `{type:'terminal', terminalId}` → terminal
- `plan` → plan (priority and status narrowed to the known values, unknown become `'medium'` / `'pending'`)
- `plan_update` → plan from `update.plan.entries`
- `usage_update` → usage
- `available_commands_update` → commands
- `config_option_update` → options via `optionsFrom({ configOptions })`
- `current_mode_update` → nothing here (the connection keeps mode state and re-emits options; see Task 4)
- anything else → `[]`

`optionsFrom(response)` reads `configOptions` (select options only, booleans skipped) else `modes` as a single `mode` option.

Run tests → PASS. Lint.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/chat apps/desktop/package.json apps/desktop/bun.lock
git commit -m "feat(chat): map ACP session updates to chat events"
```

---

### Task 4: The ACP adapter

**Files:**
- Create: `packages/plugins/chat/main/shell.ts`, `packages/plugins/chat/main/acpAdapter.ts`, `packages/plugins/chat/main/acpAdapter.test.ts`

**Interfaces:**
- Consumes: Task 1 contract, Task 3 mappers.
- Produces: `acpAdapter: ChatAdapter` (`id: 'acp'`), and the testable core `connectOverStream(stream: Stream, options: { cwd: string; resume: string | null; close: () => void }): Promise<ChatConnection>`.

- [ ] **Step 1: Failing test with a fake agent**

Use `AgentSideConnection` and `ClientSideConnection` from `@agentclientprotocol/sdk` over two in-memory `TransformStream`s joined with `ndJsonStream`. The fake agent:
- `initialize` → `{ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }`
- `newSession` → `{ sessionId: 's1', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } }`
- `prompt` → sends `agent_message_chunk` "Hello", then `requestPermission` with allow and reject options, then a `tool_call` whose status depends on the answer, then returns `{ stopReason: 'end_turn' }`
- `setSessionMode` → records the mode

The test:

```ts
test('a turn streams events, asks permission and ends', async () => {
  const { clientStream, agent } = fakeAgent()
  const connection = await connectOverStream(clientStream, { cwd: '/tmp', resume: null, close: () => undefined })
  const events: ChatEvent[] = []
  connection.onEvent((event) => {
    events.push(event)
    if (event.type === 'permission') connection.answer(event.requestId, event.options.find((option) => option.kind === 'allow_once')?.id ?? null)
  })
  expect(connection.sessionId).toBe('s1')
  expect(connection.capabilities).toEqual({ images: true, load: true, list: false })
  const { stopReason } = await connection.prompt([{ type: 'text', text: 'Hi' }])
  expect(stopReason).toBe('end_turn')
  expect(events.map((event) => event.type)).toEqual(['options', 'turn_start', 'message_chunk', 'permission', 'permission_settled', 'tool_call', 'turn_end'])
  await connection.setOption('mode', 'code')
  expect(agent.mode).toBe('code')
})

test('cancel settles a waiting permission as cancelled', async () => {
  // prompt, cancel while the permission waits; the agent receives { outcome: { outcome: 'cancelled' } } and the turn ends 'cancelled'
})
```

Write the second test fully (the fake agent resolves its prompt with `stopReason: 'cancelled'` after `cancel` arrives). Run → FAIL.

- [ ] **Step 2: Implement**

`shell.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Runs a command line the way the user's terminal would: their login shell, so PATH and sign-ins apply */
export function spawnInShell(command: string, cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const shell = process.env.SHELL || '/bin/zsh'
  return spawn(shell, ['-lc', command], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
}
```

`acpAdapter.ts`:
- `connectOverStream(stream, { cwd, resume, close })`:
  - `new ClientSideConnection(() => client, stream)` where `client` implements:
    - `sessionUpdate({ update })` → map with `fromSessionUpdate`, emit; on `current_mode_update` update the stored mode option's `currentValue` and emit `options`
    - `requestPermission(params)` → new `requestId`, emit `fromPermissionRequest`, return a promise stored in `pending: Map<string, (outcome) => void>`; `answer(id, optionId)` resolves `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }` and emits `permission_settled`
    - `readTextFile({ path, line, limit })` / `writeTextFile({ path, content })` → `node:fs/promises`, only when `path` is inside `cwd` or the home folder (`path.resolve` then `startsWith`), else throw `Error('Outside the session folder')`
  - `initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } })`
  - resume: `loadSession({ sessionId: resume, cwd, mcpServers: [] })` when `agentCapabilities.loadSession`, else `newSession`. With load the agent replays the conversation as `user_message_chunk` / `agent_message_chunk` updates, which the feed renders.
  - emit `options` from `optionsFrom(response)`
  - `prompt(content)`: emit `turn_start`, `await connection.prompt({ sessionId, prompt: toPromptBlocks(content) })`, emit `turn_end`, return `{ stopReason }`; on error emit `error` with the message and `turn_end` `cancelled`
  - `cancel()`: `connection.cancel({ sessionId })` and settle every pending permission as cancelled
  - `setOption(id, value)`: `setSessionConfigOption({ sessionId, configId: id, value })` when the session had `configOptions`, else `setSessionMode({ sessionId, modeId: value })` for `mode`; then update and emit `options`
  - `list`: present when `agentCapabilities.sessionCapabilities?.list`; `listSessions({ cwd })` mapped to `ChatSessionInfo` (title fallback "Untitled", `updatedAt` from ISO or 0)
  - `close()`: cancels pending, calls `close`
- `acpAdapter.connect({ cwd, command, env, resume })`: `spawnInShell`, `ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))`, stderr kept in a 4 KB ring for error messages; if the child exits before `initialize` resolves, reject with `Error(\`${command} exited: ${stderrTail || 'no output'}\`)`; `close` kills the child.

Check exact request field names against `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` (e.g. `SetSessionConfigOptionRequest`, `LoadSessionRequest`, `ListSessionsResponse`) and adjust; record adaptations in the report.

Run tests → PASS; typecheck; lint; `cd apps/desktop && bunx electron-vite build`.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/chat/main
git commit -m "feat(chat): ACP adapter over the agent's own CLI"
```

---

### Task 5: Chat main plugin

**Files:**
- Create: `packages/plugins/chat/shared/types.ts`, `packages/plugins/chat/main/index.ts`

**Interfaces:**
- Consumes: `MainContext.chatAdapter`, `acpAdapter`.
- Produces: bridge channels on plugin id `chat`:
  - invoke `start(chatId: string, { adapter: string; command: string; cwd: string; resume: string | null }): { agentSessionId: string; capabilities: ChatCapabilities; terminalCommand: string | null }`
  - invoke `prompt(chatId, content: ChatContent[]): { stopReason: StopReason }`
  - send `cancel(chatId)`, `answer(chatId, requestId, optionId | null)`, `stop(chatId)`
  - invoke `setOption(chatId, id, value)`, `list(chatId, cwd): ChatSessionInfo[]`
  - to renderer: `events(chatId, ChatEvent[])` batched every 50 ms, `closed(chatId, message | null)`

- [ ] **Step 1: Implement**

`shared/types.ts`: `StartOptions`, `StartResult` as above.

`main/index.ts`:

```ts
const plugin: MainPlugin = {
  chatAdapters: [acpAdapter],
  activate: (context) => {
    const connections = new Map<string, { connection: ChatConnection; owner: WebContents; dispose: () => void }>()
    context.handle('start', async (event, chatId: string, options: StartOptions) => { ... })
    ...
    context.onDispose(() => connections.forEach(({ connection }) => connection.close()))
  }
}
```

- `start`: close an existing connection for the id; find the adapter (`context.chatAdapter(options.adapter)`, error "No <adapter> adapter" when missing); `connect({ cwd, command, env: await context.sessionEnv(), resume })`; subscribe to events with a 50 ms batch queue sending `events` to `event.sender`; return `StartResult`.
- Every handler validates `typeof chatId === 'string'` and that the connection's owner is `event.sender`.
- Connection failures reject the invoke with the error message (the renderer shows it).
- When the child exits, send `closed(chatId, message)` and drop the connection.

Run: typecheck, lint, electron-vite build.

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/chat
git commit -m "feat(chat): connections per chat session in main"
```

---

### Task 6: The feed reducer

**Files:**
- Create: `packages/plugins/chat/renderer/feed.ts`, `packages/plugins/chat/renderer/feed.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`.
- Produces:

```ts
export type Block =
  | { type: 'text'; role: 'user' | 'agent'; text: string; images: { mimeType: string; data: string }[] }
  | { type: 'thought'; text: string; startedAt: number; endedAt: number | null }
  | { type: 'tool'; call: ToolCall; permission: PendingPermission | null }
  | { type: 'permission'; permission: PendingPermission }
  | { type: 'error'; message: string }
export type PendingPermission = { requestId: string; title: string; options: PermissionOption[] }
export type Feed = { blocks: Block[]; plan: PlanEntry[]; usage: { used: number; size: number } | null; options: ChatOption[]; commands: { name: string; description: string }[]; running: boolean; waiting: boolean }
export const emptyFeed: Feed
export function reduce(feed: Feed, event: ChatEvent, now: number): Feed
```

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from 'bun:test'
import type { ChatEvent } from '@treeix/sdk'
import { emptyFeed, reduce } from './feed'

const run = (events: ChatEvent[]) => events.reduce((feed, event, index) => reduce(feed, event, index * 1000), emptyFeed)

test('chunks of one role merge into one block, a new role starts another', () => {
  const feed = run([
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'Fix ' } },
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'it' } },
    { type: 'turn_start' },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'On it' } }
  ])
  expect(feed.blocks.map((block) => (block.type === 'text' ? `${block.role}:${block.text}` : block.type))).toEqual(['user:Fix it', 'agent:On it'])
  expect(feed.running).toBe(true)
})

test('thoughts time themselves and close when something else arrives', () => {
  const feed = run([{ type: 'turn_start' }, { type: 'thought_chunk', text: 'Hmm ' }, { type: 'thought_chunk', text: 'yes' }, { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Done' } }])
  expect(feed.blocks[0]).toEqual({ type: 'thought', text: 'Hmm yes', startedAt: 1000, endedAt: 3000 })
})

test('tool calls upsert by id and permissions attach to their call', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }] }
  ])
  expect(feed.waiting).toBe(true)
  expect(feed.blocks).toHaveLength(1)
  const settled = [{ type: 'permission_settled', requestId: 'r1' }, { type: 'tool_call_update', id: 't1', patch: { status: 'completed', output: [{ type: 'text', text: '4 pass' }] } }] satisfies ChatEvent[]
  const after = settled.reduce((current, event) => reduce(current, event, 9000), feed)
  expect(after.waiting).toBe(false)
  expect(after.blocks[0]).toMatchObject({ type: 'tool', permission: null, call: { status: 'completed', output: [{ type: 'text', text: '4 pass' }] } })
})

test('a permission without a known tool call stands alone', () => {
  const feed = run([{ type: 'permission', requestId: 'r2', title: 'Switch mode?', toolCallId: null, options: [] }])
  expect(feed.blocks[0]).toMatchObject({ type: 'permission', permission: { requestId: 'r2' } })
})

test('usage, plan, options, commands and turn end', () => {
  const feed = run([
    { type: 'turn_start' },
    { type: 'usage', used: 48000, size: 200000, cost: null },
    { type: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'in_progress' }] },
    { type: 'commands', commands: [{ name: 'compact', description: '' }] },
    { type: 'turn_end', stopReason: 'end_turn' }
  ])
  expect(feed).toMatchObject({ usage: { used: 48000, size: 200000 }, plan: [{ content: 'Read' }], commands: [{ name: 'compact' }], running: false })
})

test('errors become blocks and stop the turn', () => {
  expect(run([{ type: 'turn_start' }, { type: 'error', message: 'Not signed in' }])).toMatchObject({ running: false, blocks: [{ type: 'error', message: 'Not signed in' }] })
})
```

Run → FAIL.

- [ ] **Step 2: Implement `feed.ts`** as specified: merge consecutive text chunks of the same role (images collected on the block), thought blocks timed by `now` and closed (`endedAt = now`) when any non-thought block is added or on `turn_end`, tool calls upserted by id (patch merges; `output` in a patch replaces), permissions attached to the tool block with the same id else a standalone block, `permission_settled` clears it (both places), `waiting` true while any permission is pending, `running` from `turn_start` / `turn_end` / `error`, usage/plan/options/commands replaced.

Run → PASS. Lint.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/chat/renderer
git commit -m "feat(chat): feed reducer from chat events to blocks"
```

---

### Task 7: Composer helpers

**Files:**
- Create: `packages/plugins/chat/renderer/composer.ts`, `packages/plugins/chat/renderer/composer.test.ts`

**Interfaces:**
- Produces:
  - `IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']`, `MAX_IMAGE_BYTES = 5 * 1024 * 1024`
  - `imageProblem(file: { type: string; size: number }): string | null` ("Images up to 5 MB" / "PNG, JPEG, GIF or WebP only")
  - `completion(input: string, caret: number, commands: { name: string; description: string }[], files: string[]): { kind: 'command' | 'file'; query: string; start: number; items: { label: string; detail: string; insert: string }[] } | null`
  - `switchWarning(usage: { used: number } | null): { tokens: number | null } | null` (null under 10 000 known tokens; `{ tokens: null }` when usage is unknown)
  - `formatTokens(n: number): string` ("48k", "1.2M")

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from 'bun:test'
import { completion, formatTokens, imageProblem, switchWarning } from './composer'

test('imageProblem', () => {
  expect(imageProblem({ type: 'image/png', size: 1000 })).toBeNull()
  expect(imageProblem({ type: 'image/png', size: 6 * 1024 * 1024 })).toBe('Images up to 5 MB')
  expect(imageProblem({ type: 'application/pdf', size: 10 })).toBe('PNG, JPEG, GIF or WebP only')
})

test('slash completion only at the start, file completion after @ anywhere', () => {
  const commands = [{ name: 'compact', description: 'Summarize' }, { name: 'clear', description: 'Start over' }]
  expect(completion('/co', 3, commands, [])).toMatchObject({ kind: 'command', query: 'co', start: 0, items: [{ label: '/compact', insert: '/compact ' }] })
  expect(completion('fix /co', 7, commands, [])).toBeNull()
  expect(completion('see @src/pri', 12, [], ['src/pricing/Pricing.tsx', 'src/app.ts'])).toMatchObject({ kind: 'file', query: 'src/pri', start: 4, items: [{ label: 'src/pricing/Pricing.tsx', insert: '@src/pricing/Pricing.tsx ' }] })
  expect(completion('mail me@home', 12, [], ['home.ts'])).toBeNull()
})

test('switchWarning and formatTokens', () => {
  expect(switchWarning({ used: 9000 })).toBeNull()
  expect(switchWarning({ used: 48000 })).toEqual({ tokens: 48000 })
  expect(switchWarning(null)).toEqual({ tokens: null })
  expect(formatTokens(48123)).toBe('48k')
  expect(formatTokens(1234567)).toBe('1.2M')
})
```

File completion matches paths containing the query (case-insensitive), shortest first, max 8; "@" only counts at the start or after whitespace.

Run → FAIL, implement, → PASS, lint.

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/chat/renderer
git commit -m "feat(chat): composer helpers for images, completion and model switch warnings"
```

---

### Task 8: Chat store and view

**Files:**
- Create: `packages/plugins/chat/renderer/store.ts`, `Blocks.tsx`, `Composer.tsx`, `Chat.tsx`, `index.tsx`
- Modify: `packages/sdk/src/index.ts` (`Services.chat`)

**Interfaces:**
- Consumes: Tasks 5, 6, 7; `@treeix/app/LazyMarkdown` `LazyMarkdown`; `@pierre/diffs/react` `MultiFileDiff`; `@treeix/app/FileView` `codeThemeOptions`, `diffBackground`; settings `chatThinking` via `getSettings`/`useSettings` from `@treeix/app/settings`.
- Produces: `Services.chat`:

```ts
export type ChatService = {
  View: ComponentType<{ chatId: string }>
  /** Connects and remembers the agent session id; resolves with it */
  start: (chatId: string, options: { agent: string; adapter: string; command: string; cwd: string; resume: string | null }) => Promise<string>
  stop: (chatId: string) => void
  status: (chatId: string) => SessionStatus
  draft: (chatId: string, text: string) => void
  terminalCommand: (chatId: string) => string | null
  subscribe: (listener: () => void) => () => void
}
```

- [ ] **Step 1: Store**

`store.ts`: `Map<chatId, ChatState>` where `ChatState = { feed: Feed; capabilities: ChatCapabilities | null; terminalCommand: string | null; draft: string; queue: ChatContent[][]; error: string | null; connected: boolean }`. Listens to bridge `events` (reduce each with `Date.now()`) and `closed`. `send(chatId, content)`: when `feed.running`, push to `queue`; else invoke `prompt`, and when it resolves shift the next queued item and send it. Status: `waiting` → `'input'`, `running` → `'running'`, `connected` → `'idle'`, else `'exited'`. Stable snapshots for `useSyncExternalStore` (replace the per-chat object only on change).

- [ ] **Step 2: Blocks**

`Blocks.tsx`:
- `TextBlock`: user right-aligned bubble with image thumbnails (`data:` URLs); agent text through `LazyMarkdown`.
- `ThoughtBlock`: "Thought for Ns" (running: "Thinking…" with the live text), toggles; respects `chatThinking` (hidden renders nothing, expanded starts open).
- `ToolCard` by `call.kind`: read/search/fetch one line (title, first location) expandable to text output; edit/delete/move shows each diff output with `MultiFileDiff` (`oldFile` contents `oldText ?? ''`, `newFile` `newText`, `diffStyle: 'unified'`, cache keys from call id and path) and +/- counts from a line count; execute shows the title as the command and text output collapsed after 10 lines; others title plus collapsible JSON of `rawInput`. Status icon: spinner in progress, check completed, alert failed. Clicking a location opens the file in a document tab, the way the plans plugin opens plans: `host.openTab({ key: \`chat-file:${path}\`, title: baseName(path), icon: <FileIcon path={path} />, parent: 'terminal', content: host.renderFileView(cwd, path, line) })`.
- `PermissionCard`: title, the attached tool call's diff or command when present, one button per option in the agent's order and names (the first allow option styled primary); ⌘↵ picks the first allow option and Esc the first reject option while the card is the newest pending one. ACP options carry no note, so there is no note field.
- `ErrorBlock`: message plus "Open in terminal" when the chat has a terminal command.

- [ ] **Step 3: Composer**

`Composer.tsx`: textarea (auto-grow to 8 lines), Enter sends and ⇧Enter newlines, ⌘↵ sends; paste and drop images (validated with `imageProblem`, shown as removable thumbnails, read as base64); attach button only when `capabilities.images`; completion popover from `completion()` with ↑/↓/Enter/Esc (files from `window.api.listFiles(cwd)` loaded once per chat); a picker per option (mode, model, others) from `feed.options`; switching a `category: 'model'` option first checks `switchWarning(feed.usage)` and shows the warning with Switch, Summarize first (only when `commands` has `compact`: sends "/compact", waits for the turn to end, then switches) and Cancel; context meter `formatTokens(used) / formatTokens(size)` with a thin bar, amber over 80%; Send or Stop (Stop sends `cancel`); queued messages listed above the input greyed with a remove ×; one hint line: running "Esc stops the agent", usage over 80% "Context is 80% full: /compact summarizes" when compact exists, else "Paste a screenshot to show the problem".

- [ ] **Step 4: Chat view**

`Chat.tsx`: column with the feed (auto-scrolls to bottom while at bottom), the plan as a compact task list above the composer while running, the composer, and an error banner for connection errors with Retry (re-`start` with the same options) and "Open in terminal" when available. Esc anywhere in the chat cancels a running turn.

- [ ] **Step 5: Plugin**

`index.tsx`: `services: { chat: service }` where `service.start` invokes `start` and stores capabilities, `View` is `Chat`, `draft` sets the composer draft. `Root` listens for `closed` and posts a system notification ("<agent> needs you") via `new Notification(...)` when a chat turns `input` while `document.hidden`.

Add `chat: ChatService` to `Services` in `packages/sdk/src/index.ts`.

Run: typecheck, lint, tests, electron-vite build.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/chat packages/sdk/src/index.ts
git commit -m "feat(chat): chat view with streaming feed, tool cards, permissions and composer"
```

---

### Task 9: Chat sessions in the terminal plugin

**Files:**
- Modify: `packages/plugins/terminal/renderer/terminals.ts`, `TerminalPanel.tsx`, `index.tsx`, `tasks.ts` only if needed
- Modify: `packages/sdk/src/index.ts` (`SessionSummary.view`)
- Test: `packages/plugins/terminal/renderer/terminals.test.ts` for the pure parts added

**Interfaces:**
- Consumes: `Services.chat`, `Agent.chat`, `viewFor`, settings `agentViews`.
- Produces: `SessionMeta.view: 'terminal' | 'chat'` (default `'terminal'` when parsing old saved sessions), `SessionMeta.archived?: boolean`; `Session` becomes `TerminalSession | ChatSession` discriminated by `view`, where `ChatSession = SessionMeta & { id; view: 'chat'; status: SessionStatus; exitCode: null; lastOutput: number }`; `createSession(worktreePath, kind, promptArgument?, taskId?, view?)`; `switchView(id)`.

- [ ] **Step 1: Store**

- Rename the current `Session` type to `TerminalSession` and add `view: 'terminal'`; `Session = TerminalSession | ChatSession`. Narrow every xterm use (`terminal`, `fit`, `element`, `opened`) with `session.view === 'terminal'` guards; functions that only make sense for terminals (`attachSession`, `fitSession`, `pasteClipboard`, `selectAllTerminal`, `clearTerminal`, `terminalSelection`) return early for chats.
- `startChat(worktreePath, agent, taskId?, resume?)`: builds meta with `view: 'chat'`, id `crypto.randomUUID()`, adds a `ChatSession` with status `'dormant'`, places it like `createSession`, then `chat.start(id, { agent, adapter, command, cwd, resume })` and stores the returned agent session id in the meta (saved with the rest).
- Status comes from `chat.status(id)` via `chat.subscribe`, feeding the same `status` field so dots, badges and keep awake work.
- Restore on relaunch: chat sessions come back dormant and connect when their tab is first shown (resume with the saved agent session id), mirroring terminal wake-up.
- `killSession` for chats calls `chat.stop` and moves the session to History like terminals. History entries keep `view`; restoring a chat entry starts a chat with `resume`. `archived: true` hides an entry from History lists.
- `switchView(id)`: chat → terminal when `chat.terminalCommand(id)` is set (stop the chat, spawn a terminal session with that command in the same tab slot, keep the agent session id); terminal → chat when the agent has `chat` and a known agent session id (kill the terminal process, start a chat with `resume`).
- `sendText(id, text, submit)`: for chats sets the draft (`chat.draft`) and reveals the session; `submit` is ignored for chats, the user sends.

- [ ] **Step 2: Panel**

- `TerminalPanel.tsx`: panes render `<chat.View chatId={id} />` for chat sessions (same pane frame, focus and drag handling), xterm for terminals. Tab strip badge text "Claude · chat" for chats.
- The "+" menu: for each agent, the entry in its default view (`viewFor(agent, getSettings().agentViews)`), then a muted second entry for the other view when the agent has `chat` ("Claude in terminal" or "Claude chat").
- Terminal tabs of agents with `chat` and a saved agent session id get "Open as chat" in their tab menu; chat tabs get "Open in terminal" when available.
- History rows get "Archive" for chats.

- [ ] **Step 3: Palette and SDK**

`index.tsx` commands: "New <agent> chat" for agents with `chat`. `SessionSummary` gains `view`.

- [ ] **Step 4: Tests**

Extract and test the pure parts: parsing old saved metas without `view` gives `'terminal'`; `viewFor` wiring already tested; History filtering of archived entries.

Run everything; electron-vite build.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/terminal packages/sdk/src/index.ts
git commit -m "feat(terminal): chat sessions as tabs next to terminals"
```

---

### Task 10: Settings

**Files:**
- Modify: `apps/desktop/src/renderer/src/SettingsView.tsx` (Agents card, Terminal page)

**Interfaces:**
- Consumes: settings `agentViews`, `chatThinking`, `Agent.chat`.

- [ ] **Step 1: Agents card**

Each agent row with a `chat` command gets:
- "Opens as" `Segmented` Chat / Terminal writing `agentViews[agent.id]`
- the chat command as description, and an availability line: run the command's first word through the existing tool check (`window.api.checkTools` accepts tool names; for `npx` commands check `npx`, for others the binary) and show "Ready" or "Not found: <install hint>"; install hints: Claude `npm i -g @agentclientprotocol/claude-agent-acp`, Codex `npm i -g @zed-industries/codex-acp`, Gemini `npm i -g @google/gemini-cli`.
- custom agents get a "Chat command" input next to their other fields; saving a non-empty value stores `chat: { adapter: 'acp', command }`, empty removes it.

- [ ] **Step 2: Terminal page**

A "Agent sessions" card with "Thinking in chats": Collapsed / Expanded / Hidden (`chatThinking`).

Run typecheck, lint, tests.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/SettingsView.tsx
git commit -m "feat(settings): choose chat or terminal per agent"
```

---

### Task 11: Docs and verification

**Files:**
- Modify: `docs/architecture.md`, `apps/desktop/electron-builder.yml` only if the SDK needs an explicit include

- [ ] **Step 1: Docs**

After the browser paragraph in `docs/architecture.md`:

```md
The `chat` plugin gives agents a chat view next to their terminals. It talks to agents only through the `ChatAdapter` contract in `@treeix/sdk`: an adapter connects to an agent's command and turns what it says into `ChatEvent`s. Any plugin can contribute adapters with `MainPlugin.chatAdapters`; the chat plugin ships the Agent Client Protocol adapter, which covers Claude, Codex and Gemini through their ACP commands. Agents opt in with `Agent.chat` in the registry, run through the user's login shell like terminal sessions, and keep their own transcripts; chat sessions live in the terminal plugin's groups and tabs with `view: 'chat'`.
```

- [ ] **Step 2: Package check**

`cd apps/desktop && bunx electron-builder --mac --dir -c.mac.identity=null` (or the project's pack script) and confirm `@agentclientprotocol/sdk` is inside `app.asar` and the DMG size grew by under 2 MB.

- [ ] **Step 3: Full checks**

`bun run typecheck && bun test && bunx oxlint packages apps/desktop/src && cd apps/desktop && bunx electron-vite build`.

- [ ] **Step 4: Manual (controller runs in the app)**

With `claude-agent-acp`, `codex-acp` and Gemini installed: start each as a chat; approve and reject a command; switch mode and model (warning shows with tokens where usage is reported); paste a screenshot; stop mid-turn; queue a message while working; close and restore from History; relaunch and reopen; archive; set "Opens as: Chat" and start from "+"; send review comments to a chat (lands as a draft); status dot and keep awake while a permission waits; a system notification when the window is hidden.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: chat plugin and adapters"
```

---

## Self-review notes

- Spec coverage: adapter contract and contribution (T1), registry and default view (T2, T10), ACP adapter incl. permissions, modes/models, list, load, fs (T3, T4), main connections (T5), feed incl. thoughts, tools, plan, usage, permissions (T6), composer incl. images, completion, model warning, meter, hints, queue (T7, T8), tabs, History, archive, restore, view switching, drafts (T9), settings (T10), errors: missing command via availability and connection errors (T5, T8, T10), notifications (T8), docs and package size (T11).
- Deviations are the rulings at the top; "Open in terminal" stays hidden for ACP agents until id parity is verified (spec risk).
- Types defined once: `ChatEvent` family (T1), `Feed`/`Block` (T6), composer helpers (T7), `ChatService` (T8), `Session` union (T9).
