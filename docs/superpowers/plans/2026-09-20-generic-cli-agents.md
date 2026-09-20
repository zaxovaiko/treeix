# Any CLI agent through a command config: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add any terminal coding agent in Settings by giving its command, instead of Treeix knowing only `claude`, `codex` and `shell` at compile time.

**Architecture:** A new host module `apps/desktop/src/renderer/src/agents.ts` owns the `Agent` shape, a table of three built-in agents, and a lookup that merges user-defined agents over it. `SessionKind` in the SDK stops being a union of three literals and becomes an open `string`. Every place that spawned, resumed, badged or listed an agent by name reads the table instead.

**Tech Stack:** TypeScript, React 19, Electron 39, Bun for tests, Tailwind classes in the existing components.

**Spec:** [`docs/superpowers/specs/2026-09-20-generic-cli-agents-design.md`](../specs/2026-09-20-generic-cli-agents-design.md)

## Global Constraints

- TypeScript with `any` banned. Use `unknown` at trust boundaries (parsed JSON) and narrow with a type guard.
- `as const` over `enum`, per the repo's conventions.
- No em or en dashes anywhere, including comments and UI copy. Hyphens only.
- Clear names instead of comments. A comment is for why, never what.
- CI commands that must pass before any task is called done: `bun run typecheck` and `bun run test`, both from the repo root.
- Conventional commit messages. Never add AI attribution lines to a commit.
- Tests are `bun:test`, colocated as `<name>.test.ts` beside the module. They import the module under test with a dynamic `await import('./module')` when it touches `localStorage`, matching `apps/desktop/src/renderer/src/settings.test.ts`.
- Each task must leave the repo compiling. Do not delete `SESSION_KINDS` before Task 3, which updates every consumer in the same commit.

---

### Task 1: The agent registry and its setting

**Files:**
- Create: `apps/desktop/src/renderer/src/agents.ts`
- Create: `apps/desktop/src/renderer/src/agents.test.ts`
- Modify: `apps/desktop/src/renderer/src/settings.ts` (the `Settings` type near line 7, `DEFAULTS` near line 143, `load()` near line 152)

**Interfaces:**
- Consumes: `getSettings` and `subscribeSettings` from `./settings`; the `SessionKind` type from `@treeix/sdk`, which is still the three-literal union at this point and will widen in Task 3.
- Produces: `Agent`, `BUILTIN_AGENTS`, `getAgents()`, `getAgent(id)`, `agentOr(id)`, `isAgent(id)`, `useAgents()`, `startCommand(agent, prompt?, agentSessionId?)`, `resumeCommandFor(agent, agentSessionId)`, and `Settings['customAgents']`.

This task adds the registry beside the existing code without wiring anything to it. Nothing changes behaviour yet, which is why it can be reviewed on its own.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/agents.test.ts`:

```ts
import { expect, test } from 'bun:test'

const stub = (customAgents: unknown[]): void => {
  const stored = JSON.stringify({ customAgents })
  globalThis.localStorage = { getItem: () => stored, setItem: () => undefined } as unknown as Storage
}

test('built-in commands keep the behaviour they had when they were hardcoded', async () => {
  stub([])
  const { BUILTIN_AGENTS, startCommand, resumeCommandFor } = await import('./agents')
  const claude = BUILTIN_AGENTS.claude
  expect(startCommand(claude)).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS"')
  expect(startCommand(claude, "'fix the test'", 'abc')).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS" --session-id abc \'fix the test\'')
  expect(resumeCommandFor(claude, 'abc')).toContain('~/.claude/projects/*/abc.jsonl')
  expect(resumeCommandFor(claude, 'abc')).toContain('--resume abc')
  expect(resumeCommandFor(claude, null)).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS"')
  expect(resumeCommandFor(BUILTIN_AGENTS.codex, null)).toBe('codex resume --last')
})

test('a shell session runs the prompt as its command line, or nothing at all', async () => {
  stub([])
  const { BUILTIN_AGENTS, startCommand, resumeCommandFor } = await import('./agents')
  expect(startCommand(BUILTIN_AGENTS.shell)).toBeUndefined()
  expect(startCommand(BUILTIN_AGENTS.shell, 'bun run dev')).toBe('bun run dev')
  expect(resumeCommandFor(BUILTIN_AGENTS.shell, null)).toBeUndefined()
})

test('a custom agent gets its prompt behind the flag it declares', async () => {
  const aider = { id: 'aider', label: 'Aider', mark: 'A', color: '#fff', command: 'aider', promptFlag: '--message', agent: true }
  stub([aider])
  const { getAgents, getAgent, isAgent, startCommand, resumeCommandFor } = await import('./agents')
  expect(getAgents().map((entry) => entry.id)).toEqual(['claude', 'codex', 'shell', 'aider'])
  expect(startCommand(getAgent('aider')!, "'add a test'")).toBe("aider --message 'add a test'")
  expect(resumeCommandFor(getAgent('aider')!, 'abc')).toBe('aider')
  expect(isAgent('aider')).toBe(true)
  expect(isAgent('shell')).toBe(false)
})

test('a custom agent replaces the built-in it shares an id with', async () => {
  stub([{ id: 'claude', label: 'Claude', mark: '✳', color: '#fff', command: '/opt/claude', agent: true }])
  const { getAgents, getAgent } = await import('./agents')
  expect(getAgents()).toHaveLength(3)
  expect(getAgent('claude')?.command).toBe('/opt/claude')
})

test('a malformed stored agent is dropped and missing fields get defaults', async () => {
  stub([null, 'aider', { label: 'No id' }, { id: 'bare' }])
  const { getAgents, getAgent } = await import('./agents')
  expect(getAgents().map((entry) => entry.id)).toEqual(['claude', 'codex', 'shell', 'bare'])
  expect(getAgent('bare')).toMatchObject({ label: 'bare', mark: '●', command: null, agent: true })
})

test('an agent that is gone falls back to a neutral row instead of crashing', async () => {
  stub([])
  const { getAgent, agentOr, isAgent } = await import('./agents')
  expect(getAgent('deleted')).toBeUndefined()
  expect(agentOr('deleted')).toMatchObject({ id: 'deleted', label: 'deleted', command: null, agent: false })
  expect(isAgent('deleted')).toBe(false)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test apps/desktop/src/renderer/src/agents.test.ts`
Expected: FAIL, the module `./agents` cannot be resolved.

- [ ] **Step 3: Write the registry**

Create `apps/desktop/src/renderer/src/agents.ts`:

```ts
import { useSyncExternalStore } from 'react'
import type { SessionKind } from '@treeix/sdk'
import { getSettings, subscribeSettings } from './settings'

export type Agent = {
  id: SessionKind
  label: string
  /** One glyph on the session's badge */
  mark: string
  color: string
  /** null runs the user's plain login shell */
  command: string | null
  /** Flag carrying the first prompt; an empty string passes it as a positional argument */
  promptFlag?: string
  /** Flag given a freshly generated conversation uuid, so a relaunch can resume exactly it */
  sessionIdFlag?: string
  /** Command that resumes a conversation; `{id}` is replaced with the session's uuid */
  resumeCommand?: string
  /** false only for the shell, which is a terminal rather than an agent */
  agent: boolean
}

/** The usage-limits plugin fills the variable with its status line bridge; the terminal plugin's main module defaults it to `{}` */
const CLAUDE = 'claude --settings "$TREEIX_CLAUDE_SETTINGS"'

export const BUILTIN_AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    mark: '✳',
    color: '#d97757',
    command: CLAUDE,
    promptFlag: '',
    sessionIdFlag: '--session-id',
    // A session closed before its first message has no transcript, and --resume would fail on it
    resumeCommand: `if ls ~/.claude/projects/*/{id}.jsonl >/dev/null 2>&1; then ${CLAUDE} --resume {id}; else ${CLAUDE} --session-id {id}; fi`,
    agent: true
  },
  // ponytail: Codex can't be given an id up front, so relaunch resumes its latest conversation; read ~/.codex/sessions if two Codex sessions clash
  codex: { id: 'codex', label: 'Codex', mark: '◎', color: 'var(--color-foreground)', command: 'codex', promptFlag: '', resumeCommand: 'codex resume --last', agent: true },
  shell: { id: 'shell', label: 'Shell', mark: '$', color: '#34d399', command: null, agent: false }
} as const satisfies Record<string, Agent>

/** Built-ins first, then the user's; a custom agent sharing a built-in id replaces it in place */
export function getAgents(): Agent[] {
  const custom = getSettings().customAgents
  const builtins = Object.values(BUILTIN_AGENTS).map((agent) => custom.find((entry) => entry.id === agent.id) ?? agent)
  return [...builtins, ...custom.filter((entry) => !(entry.id in BUILTIN_AGENTS))]
}

export const getAgent = (id: SessionKind): Agent | undefined => getAgents().find((agent) => agent.id === id)

/** A session whose agent the user has deleted still has to render */
export const agentOr = (id: SessionKind): Agent => getAgent(id) ?? { id, label: id, mark: '●', color: 'var(--color-muted-foreground)', command: null, agent: false }

export const isAgent = (id: SessionKind): boolean => getAgent(id)?.agent ?? false

export const useAgents = (): Agent[] => useSyncExternalStore(subscribeSettings, getAgents)

/** The command line that starts the agent, or undefined to drop the user into their shell */
export function startCommand(agent: Agent, prompt?: string, agentSessionId?: string | null): string | undefined {
  // A shell session takes the prompt as the command line to run
  if (!agent.command) return prompt
  const id = agent.sessionIdFlag && agentSessionId ? ` ${agent.sessionIdFlag} ${agentSessionId}` : ''
  const first = prompt ? ` ${agent.promptFlag ? `${agent.promptFlag} ` : ''}${prompt}` : ''
  return `${agent.command}${id}${first}`
}

export function resumeCommandFor(agent: Agent, agentSessionId: string | null): string | undefined {
  const template = agent.resumeCommand
  if (!template) return startCommand(agent, undefined, agentSessionId)
  if (!template.includes('{id}')) return template
  return agentSessionId ? template.replaceAll('{id}', agentSessionId) : startCommand(agent, undefined, agentSessionId)
}
```

`useAgents` passes `getAgents` straight to `useSyncExternalStore`, which builds a new array on every render pass. React compares by reference, so this re-renders more than it must. That is fine here: the list has a handful of entries and changes only when Settings is edited. Do not add memoisation the codebase does not need.

- [ ] **Step 4: Add the setting**

In `apps/desktop/src/renderer/src/settings.ts`, import the type next to the existing imports at the top of the file:

```ts
import type { Agent } from './agents'
```

It must be `import type`. `agents.ts` imports `getSettings` from this module at runtime, and a value import here would close the cycle.

Add the field to the `Settings` type, after `plugins`:

```ts
  /** Agents the user added or redefined, merged over the built-in table by id */
  customAgents: Agent[]
```

Add `customAgents: []` to `DEFAULTS`. Add a parser beside `parseKeymap` and `parseDigitShortcuts`:

```ts
function parseCustomAgents(value: unknown): Agent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): Agent[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const candidate = entry as Record<string, unknown>
    const text = (key: string): string | undefined => (typeof candidate[key] === 'string' ? (candidate[key] as string) : undefined)
    const id = text('id')
    if (!id) return []
    return [
      {
        id,
        label: text('label') ?? id,
        mark: text('mark') ?? '●',
        color: text('color') ?? 'var(--color-foreground)',
        command: text('command') ?? null,
        promptFlag: text('promptFlag'),
        sessionIdFlag: text('sessionIdFlag'),
        resumeCommand: text('resumeCommand'),
        agent: candidate.agent !== false
      }
    ]
  })
}
```

Call it in `load()`, in the returned object: `customAgents: parseCustomAgents(candidate.customAgents),`

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test apps/desktop/src/renderer/src/agents.test.ts`
Expected: PASS, all six tests.

Run: `bun run typecheck`
Expected: PASS. `SESSION_KINDS` is untouched, so nothing else moved.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/agents.ts apps/desktop/src/renderer/src/agents.test.ts apps/desktop/src/renderer/src/settings.ts
git commit -m "feat(agents): registry of built-in and user-defined agents"
```

---

### Task 2: Spawn and resume from the registry

**Files:**
- Modify: `packages/plugins/terminal/renderer/terminals.ts` (`CLAUDE` near line 367, `startSession` near line 375, `resumeCommand` near line 402, `isSessionMeta` near line 427, `detectStatus` near line 186)

**Interfaces:**
- Consumes: `agentOr`, `getAgent`, `isAgent`, `startCommand`, `resumeCommandFor` from Task 1, imported as `@treeix/app/agents`. That alias resolves to `apps/desktop/src/renderer/src` and is already how this file imports `getSettings` from `@treeix/app/settings`.
- Produces: no new exports. `startSession` and `resumeCommand` keep their current signatures.

The two vendor branches leave this file. Behaviour is unchanged for all three built-ins, which is what the Task 1 tests already pin down.

- [ ] **Step 1: Import the registry**

In `packages/plugins/terminal/renderer/terminals.ts`, beside the existing `import { ... } from '@treeix/app/settings'` line:

```ts
import { agentOr, getAgent, isAgent, resumeCommandFor, startCommand } from '@treeix/app/agents'
```

- [ ] **Step 2: Replace the start path**

Delete the `const CLAUDE = 'claude --settings "$TREEIX_CLAUDE_SETTINGS"'` line and its comment. It now lives in `BUILTIN_AGENTS.claude`.

Replace the body of `startSession` between the `sameKind` line and the `spawnSession` call:

```ts
async function startSession(worktreePath: string, kind: SessionKind, promptArgument?: string): Promise<string> {
  const sameKind = state.sessions.filter((session) => session.worktreePath === worktreePath && session.kind === kind)
  const agent = agentOr(kind)
  const agentSessionId = agent.sessionIdFlag ? crypto.randomUUID() : null
  const meta: SessionMeta = {
    worktreePath,
    kind,
    title: `${agent.label}${sameKind.length ? ` ${sameKind.length + 1}` : ''}`,
    startedAt: Date.now(),
    workspaceId: getCurrentWorkspaceId(),
    agentSessionId
  }
  const id = await spawnSession(meta, startCommand(agent, promptArgument, agentSessionId))
  await openSession(id, meta, '', null)
  return id
}
```

- [ ] **Step 3: Replace the resume path**

Replace the whole `resumeCommand` function and the `// ponytail: Codex ...` comment above it, which moved into `agents.ts`:

```ts
/** An agent the user has since deleted has no command, so its session reopens as a plain shell in its folder */
function resumeCommand(meta: SessionMeta): string | undefined {
  const agent = getAgent(meta.kind)
  return agent ? resumeCommandFor(agent, meta.agentSessionId) : undefined
}
```

Its three callers at `wakeSession`, `restoreSessions` and `restoreClosedSession` need no change.

- [ ] **Step 4: Open the persisted kind and the agent test**

In `isSessionMeta`, replace the three-literal check:

```ts
  return typeof candidate.worktreePath === 'string' && typeof candidate.title === 'string' && typeof candidate.kind === 'string'
```

In `detectStatus`, replace the shell exclusion:

```ts
  if (isAgent(session.kind) && WAITING_FOR_INPUT.test(screen)) return 'input'
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run test`
Expected: PASS, including the existing `terminals` sibling tests.

- [ ] **Step 6: Manual check, because this is the path that starts processes**

Run: `bun run dev`. In the app: start a Claude session, a Codex session and a shell session in a worktree. Confirm each starts. Reload the window with Cmd+R and confirm all three reattach. Quit and relaunch, then open the Claude session and confirm it resumes the same conversation rather than starting an empty one.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/terminal/renderer/terminals.ts
git commit -m "refactor(terminal): spawn and resume sessions from the agent registry"
```

---

### Task 3: Open `SessionKind` and drop `SESSION_KINDS`

**Files:**
- Modify: `packages/sdk/src/index.ts:69-78`
- Modify: `apps/desktop/src/renderer/src/sessionUi.tsx:3` and `:20-27`
- Modify: `apps/desktop/src/renderer/src/BranchDialog.tsx:6` and `:194-210`
- Modify: `apps/desktop/src/renderer/src/SendButton.tsx:16`, `:74-89`, `:128`, `:199-205`
- Modify: `apps/desktop/src/renderer/src/App.tsx:14`, `:534-535`, `:566-572`, `:966`
- Modify: `apps/desktop/src/renderer/src/WorkspaceRail.tsx:24`
- Modify: `packages/plugins/terminal/renderer/index.tsx:11` and `:483-491`
- Modify: `packages/plugins/terminal/renderer/TaskList.tsx:11`, `:88`, `:169`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `SessionKind = string` in the SDK. `SESSION_KINDS` no longer exists.

One commit, because deleting the export breaks every consumer at once and a half-migrated tree does not compile.

- [ ] **Step 1: Widen the type in the SDK**

In `packages/sdk/src/index.ts`, replace the `SessionKind` union and the whole `SESSION_KINDS` constant with:

```ts
/** An agent id, open because users define their own in Settings; the table of known ids is `@treeix/app/agents` */
export type SessionKind = string
```

Leave `SessionStatus`, `SessionSummary` and `SessionsService` exactly as they are. Their `kind` fields widen with the type.

- [ ] **Step 2: Run the typecheck to get the list of breaks**

Run: `bun run typecheck`
Expected: FAIL, with errors naming `SESSION_KINDS` in `sessionUi.tsx`, `BranchDialog.tsx`, `App.tsx`, `terminal/renderer/index.tsx` and `TaskList.tsx`. Work through them in the steps below and use this output to confirm you missed none.

- [ ] **Step 3: The badge**

In `apps/desktop/src/renderer/src/sessionUi.tsx`, change the import to take only types from the SDK and pull the lookup from the registry:

```ts
import { agentOr } from './agents'
import type { SessionKind, SessionStatus, SessionSummary } from '@treeix/sdk'
```

and in `KindBadge`:

```ts
  const { mark, color } = agentOr(kind)
```

- [ ] **Step 4: The new branch dialog**

In `apps/desktop/src/renderer/src/BranchDialog.tsx`, replace the SDK import of `SESSION_KINDS` with `import { Kbd, type SessionKind } from '@treeix/sdk'` and add `import { type Agent, useAgents } from './agents'`.

Inside the component, before the returned JSX, add `const agents = useAgents()`. Replace the options row:

```tsx
            {[null, ...agents].map((agent: Agent | null) => (
              <button
                key={agent?.id ?? 'none'}
                onClick={() => setSession(agent?.id ?? null)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ${
                  (session ?? null) === (agent?.id ?? null) ? 'bg-foreground/[.08] text-foreground ring-input' : 'text-muted-foreground ring-border hover:bg-accent'
                }`}
              >
                {agent ? (
                  <>
                    <KindBadge kind={agent.id} />
                    {agent.label}
                  </>
                ) : (
                  'Nothing'
                )}
              </button>
            ))}
```

The old row stored the string `'none'` in state while `NewBranchRequest.session` is typed `SessionKind | null`. Now that `SessionKind` is `string`, `'none'` would type-check and silently spawn an agent called "none", so the null is stored directly instead. Check the rest of the file for any remaining `'none'` comparison and remove it.

- [ ] **Step 5: The send menu**

In `apps/desktop/src/renderer/src/SendButton.tsx`, add `import { agentOr, isAgent, useAgents } from './agents'`.

Line 16 and line 128, both filtering sessions:

```ts
  const agents = alive.filter((session) => session.worktreePath === worktreePath && isAgent(session.kind))
```

```ts
  const elsewhere = alive.filter((session) => session.worktreePath !== worktreePath && isAgent(session.kind))
```

`startAgent` takes any agent id, and its message reads the label from the registry:

```ts
  const startAgent = (kind: SessionKind): void => {
    closeMenu()
    if (!service) return
    const text = prompt()
    if (submit) {
      // As the opening prompt the comments go straight to the agent
      service.start(worktreePath, kind, shellQuote(text)).then((id) => lastTargets.set(worktreePath, id))
    } else {
      // Pasted into the input once the agent is up, so there is room to add context before pressing Enter
      service.start(worktreePath, kind).then(async (id) => {
        lastTargets.set(worktreePath, id)
        await service.whenReady(id)
        service.sendText(id, text, false)
      })
    }
    onDone(`Started ${agentOr(kind).label} with ${label}`)
  }
```

Add `SessionKind` to the existing type-only SDK import. In the component body add `const startable = useAgents().filter((agent) => agent.agent)`, and replace the two hardcoded buttons:

```tsx
          {service &&
            startable.map((agent) => (
              <button key={agent.id} onClick={() => startAgent(agent.id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
                <span className="w-3" />
                <KindBadge kind={agent.id} /> New {agent.label} session with comments
              </button>
            ))}
```

- [ ] **Step 6: The branch menu and the session menu**

In `apps/desktop/src/renderer/src/App.tsx`, drop `SESSION_KINDS` from the SDK import and add `import { getAgents, isAgent } from './agents'`.

Replace the two fixed branch entries at lines 534 and 535 with one entry per agent:

```ts
      ...(sessionsAvailable ? getAgents().map((agent) => ({ label: `Open as worktree with ${agent.label}`, run: () => openBranch(branch, repo, agent.id) })) : []),
```

`branchMenu` builds an array of `MenuEntry | false | null`, so a spread of an array fits where the two `sessionsAvailable && {...}` entries were. Keep the `null` separator that follows them.

Replace `sessionEntries`:

```ts
  const sessionEntries = (cwd: string): MenuEntry[] =>
    sessionsAvailable ? getAgents().map((agent) => ({ label: `New ${agent.label} session here`, run: () => startSession(agent.id, cwd) })) : []
```

At line 966, the worktree activity map:

```ts
    else if (session.status === 'running' && isAgent(session.kind)) activity[session.worktreePath] ??= 'running'
```

These are context menus built on click rather than rendered, so they call `getAgents()` and not the hook.

- [ ] **Step 7: The workspace rail**

In `apps/desktop/src/renderer/src/WorkspaceRail.tsx`, add `import { isAgent } from './agents'` and replace line 24:

```ts
  return mine.some((session) => session.status === 'running' && isAgent(session.kind)) ? 'running' : null
```

- [ ] **Step 8: The palette and the task badge**

In `packages/plugins/terminal/renderer/index.tsx`, remove `SESSION_KINDS` from the `@treeix/sdk` import, add `import { getAgents } from '@treeix/app/agents'`, and replace the mapped commands:

```ts
    ...getAgents().map((agent) => ({
      id: `session:${agent.id}`,
      group: 'Actions',
      label: `New ${agent.label} tab`,
      detail: scope.task ? taskLabel(scope.task, host.repos) : (host.selectedWorktreeLabel ?? '~ home'),
      icon: 'terminal' as const,
      shortcut: agent.id === 'shell' ? actionKeys('terminal.newTab') || undefined : undefined,
      run: () => newTab(host, agent.id)
    })),
```

In `packages/plugins/terminal/renderer/TaskList.tsx`, drop `SESSION_KINDS` from the `./terminals` import, add `import { agentOr, isAgent } from '@treeix/app/agents'`, and replace line 88 and the badge at line 169. The badge showed Claude's glyph whatever the agent was; it now shows the first agent actually in the group:

```ts
          const agentsHere = sessions.filter((session) => panes.includes(session.id) && isAgent(session.kind))
          const agents = agentsHere.length
```

```tsx
                  {agents > 0 && (
                    <span className="flex items-center gap-0.5">
                      <span style={{ color: agentOr(agentsHere[0].kind).color }}>{agentOr(agentsHere[0].kind).mark}</span>
                      {agents}
                    </span>
                  )}
```

`terminals.ts` re-exports `SESSION_KINDS` at its top (`export { SESSION_KINDS, type SessionKind, type SessionStatus }`). Drop `SESSION_KINDS` from that re-export and keep the two types.

- [ ] **Step 9: Verify**

Run: `bun run typecheck`
Expected: PASS, and `grep -rn "SESSION_KINDS" apps packages --include="*.ts" --include="*.tsx"` returns nothing.

Run: `bun run test`
Expected: PASS.

- [ ] **Step 10: Manual check**

Run: `bun run dev`. Confirm: the command palette lists "New Claude tab", "New Codex tab" and "New Shell tab"; a branch's context menu offers all three; the new branch dialog shows Nothing, Claude, Codex and Shell and starts the one you pick; the comments drawer's send menu offers a new Claude and a new Codex session; a group with a Codex session in it shows Codex's glyph on its badge rather than Claude's.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(sdk): open SessionKind and read every agent list from the registry"
```

---

### Task 4: Edit agents in Settings

**Files:**
- Modify: `apps/desktop/src/renderer/src/SettingsView.tsx` (`SECTION_EXTRAS` near line 765, `useSettingEntries` near line 792, add an `Agents` component before `SECTION_EXTRAS`)
- Modify: `README.md` (the terminal plugin row of the plugin table, and the "Sessions keep running" bullet)

**Interfaces:**
- Consumes: `Agent`, `BUILTIN_AGENTS`, `useAgents` from Task 1; `Card`, `Row`, `SearchGroup` from `./settingsUi`, already imported at the top of `SettingsView.tsx`.
- Produces: the user-facing feature. Nothing else imports this component.

- [ ] **Step 1: Write the component**

In `apps/desktop/src/renderer/src/SettingsView.tsx`, add `import { type Agent, BUILTIN_AGENTS, useAgents } from './agents'` and, before `SECTION_EXTRAS`:

```tsx
/** The text fields of an Agent; `id` is generated and `agent` is not worth a switch until something needs it */
type AgentField = 'label' | 'command' | 'mark' | 'color' | 'promptFlag' | 'sessionIdFlag' | 'resumeCommand'

const AGENT_FIELDS: { key: AgentField; label: string; placeholder: string }[] = [
  { key: 'label', label: 'Name', placeholder: 'Aider' },
  { key: 'command', label: 'Command', placeholder: 'aider' },
  { key: 'mark', label: 'Badge', placeholder: 'A' },
  { key: 'color', label: 'Colour', placeholder: '#34d399' },
  { key: 'promptFlag', label: 'Prompt flag', placeholder: 'empty passes it as an argument' },
  { key: 'sessionIdFlag', label: 'Session id flag', placeholder: '--session-id' },
  { key: 'resumeCommand', label: 'Resume command', placeholder: 'aider --restore, {id} is the session id' }
]

function AgentRow({ agent, builtin }: { agent: Agent; builtin: boolean }): React.JSX.Element {
  const custom = useSettings().customAgents
  const write = (next: Agent[]): void => updateSettings({ customAgents: next })
  const edit = (key: AgentField, value: string): void =>
    write(custom.map((entry) => (entry.id === agent.id ? { ...entry, [key]: key === 'command' && !value ? null : value } : entry)))
  return (
    <SearchGroup title={`${agent.label} ${agent.command ?? ''}`} className="border-b border-border last:border-b-0">
      <Row label={agent.label} description={agent.command ?? 'Runs your login shell'}>
        {builtin ? (
          <button onClick={() => write([...custom, { ...agent }])} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground">
            Override
          </button>
        ) : (
          <button onClick={() => write(custom.filter((entry) => entry.id !== agent.id))} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-red-400">
            Remove
          </button>
        )}
      </Row>
      {!builtin &&
        AGENT_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} description="">
            <input
              value={String(agent[field.key] ?? '')}
              placeholder={field.placeholder}
              onChange={(event) => edit(field.key, event.target.value)}
              className="h-6 w-56 rounded-md bg-muted px-2 text-[11px] ring-1 ring-border"
            />
          </Row>
        ))}
    </SearchGroup>
  )
}

function Agents(): React.JSX.Element {
  const agents = useAgents()
  const custom = useSettings().customAgents
  const add = (): void => {
    const id = `agent-${agents.length + 1}`
    updateSettings({ customAgents: [...custom, { id, label: 'New agent', mark: '●', color: 'var(--color-foreground)', command: '', agent: true }] })
  }
  return (
    <Card title="Agents">
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} builtin={!custom.some((entry) => entry.id === agent.id)} />
      ))}
      <Row label="Add an agent" description="Any CLI agent Treeix can start in a worktree. Override a built-in to change its command.">
        <button onClick={add} className="h-6 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground">
          Add
        </button>
      </Row>
    </Card>
  )
}
```

The generated id is a placeholder the user never sees. It has to be stable and unique because sessions are stored against it, so it is not derived from the editable name.

- [ ] **Step 2: Register it**

```ts
const SECTION_EXTRAS: Partial<Record<SectionId, ComponentType>> = { Appearance: Themes, Terminal: Agents, Keyboard: Shortcuts, Plugins, Integrations: Tools }
```

In `useSettingEntries`, beside the existing Theme entry:

```ts
    { section: 'Terminal', card: 'Agents', label: 'Agents' },
```

- [ ] **Step 3: Verify in the app**

Run: `bun run typecheck && bun run test`
Expected: PASS.

Run: `bun run dev`. In Settings, Terminal, Agents: add an agent, name it, give it a command you have installed, for example `bash -l`. Confirm it appears immediately in the command palette as "New <name> tab", in a branch's context menu and in the new branch dialog. Start it in a worktree and confirm the process runs. Quit and relaunch and confirm the session comes back. Remove the agent in Settings and confirm the old session still lists without crashing and reopens as a plain shell.

- [ ] **Step 4: Update the README**

In `README.md`, the plugin table's `terminal` row currently reads "Terminal tab, docked panel, Claude, Codex and shell sessions". Change it to "Terminal tab, docked panel, sessions for Claude, Codex, a shell or any agent you configure".

The "Sessions keep running" bullet reads "Claude, Codex and shell sessions survive a reload". Change it to "Claude, Codex, a shell or any CLI agent you add survive a reload".

Leave the optional command line tools list alone. `claude` and `codex` are still the two the app checks versions for.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/SettingsView.tsx README.md
git commit -m "feat(settings): add and override agents"
```

---

## What this plan does not do

Carried from the spec, so nobody implements them by accident:

- `usage-limits` and `plans` stay Claude and Codex specific.
- The tool version registry in `packages/plugins/terminal/main/index.ts:7` keeps checking `claude` and `codex` only. A custom agent gets no update check.
- No per-agent environment variables. `TREEIX_CLAUDE_SETTINGS` stays a fixed default set by the terminal plugin's main module.
- No browser element comments. The spec's closing section records the three places in `apps/desktop/src/shared/comments.ts` that will need widening when that work starts.
