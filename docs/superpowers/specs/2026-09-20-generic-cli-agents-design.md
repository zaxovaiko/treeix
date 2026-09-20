# Any CLI agent through a command config

Date: 2026-09-20
Status: approved, not implemented

## Problem

Treeix runs three session kinds and their names are compiled in: `SessionKind = 'claude' | 'codex' | 'shell'`
in `packages/sdk/src/index.ts`. Adding Aider, Cursor CLI, OpenCode or anything else means editing the SDK,
the terminal plugin and four renderer files, then cutting a release. Users cannot add an agent themselves.

Everything an agent needs from us is already a string: a command to spawn, an optional flag for its first
prompt, an optional flag for a conversation id, and an optional command to resume. The task is to stop
hardcoding those four strings for two vendors and read them from a registry instead.

## Decisions taken before the design

- `SessionKind` becomes an open `string`. A TypeScript `enum` or a `as const` union cannot hold values the
  user types into Settings at runtime, so the closed set moves from the type to a data table of defaults.
- Custom agents get conversation resume only through a `resumeCommand` template they write themselves.
  No per-agent code paths, no plugin hook.
- Agents are edited in a Settings section, stored with the rest of the settings. No separate JSON file.
- The first prompt is passed on the command line, with a configurable flag. No typing into the TUI.

## The registry

Split across two files, following the split that already exists between the SDK and the host: the SDK holds
the type, the host holds the data and the lookup. Plugins import host modules through the `@treeix/app`
alias today, the way `terminals.ts` imports `getSettings` from `@treeix/app/settings`, so a new host module
needs no new wiring.

`packages/sdk/src/index.ts` keeps one line of this and loses the rest. `SESSION_KINDS` is deleted and the
union becomes:

```ts
/** An agent id, open because users define their own in Settings */
export type SessionKind = string
```

Everything else lives in the new host module `apps/desktop/src/renderer/src/agents.ts`, which owns both the
shape and the data:

```ts
export type Agent = {
  id: SessionKind
  label: string
  /** One glyph shown on the session's badge */
  mark: string
  color: string
  /** null runs the user's plain login shell */
  command: string | null
  /** Flag carrying the first prompt; '' passes it as a positional argument */
  promptFlag?: string
  /** Flag given a freshly generated conversation uuid, so a relaunch can resume exactly it */
  sessionIdFlag?: string
  /** Command that resumes a conversation; `{id}` is replaced with the session's uuid */
  resumeCommand?: string
  /** false only for shell; replaces every `kind !== 'shell'` test */
  agent: boolean
}

export const BUILTIN_AGENTS = {
  claude: {
    id: 'claude', label: 'Claude', mark: '✳', color: '#d97757', agent: true,
    // The usage-limits plugin fills the variable with its status line bridge
    command: 'claude --settings "$TREEIX_CLAUDE_SETTINGS"',
    promptFlag: '',
    sessionIdFlag: '--session-id',
    resumeCommand:
      'if ls ~/.claude/projects/*/{id}.jsonl >/dev/null 2>&1; ' +
      'then claude --settings "$TREEIX_CLAUDE_SETTINGS" --resume {id}; ' +
      'else claude --settings "$TREEIX_CLAUDE_SETTINGS" --session-id {id}; fi'
  },
  codex: {
    id: 'codex', label: 'Codex', mark: '◎', color: 'var(--color-foreground)', agent: true,
    command: 'codex', promptFlag: '', resumeCommand: 'codex resume --last'
  },
  shell: { id: 'shell', label: 'Shell', mark: '$', color: '#34d399', command: null, agent: false }
} as const satisfies Record<string, Agent>

/** Built-ins then custom agents; a custom agent with a built-in id replaces it */
export function getAgents(): Agent[]
export function getAgent(id: SessionKind): Agent | undefined
export function isAgent(id: SessionKind): boolean
export function useAgents(): Agent[]
```

The three built-ins keep the exact behaviour they have today. Claude's `--settings` wrapper and its
conditional resume snippet, and Codex's `resume --last`, move out of `terminals.ts` and into their rows
here, so no module outside this table knows either vendor's name.

`getAgents` reads `customAgents` from `./settings` and merges it over `BUILTIN_AGENTS`. Keeping the whole
registry in the host rather than the SDK means the SDK stays free of runtime dependencies on app code, and
avoids an import cycle: `settings.ts` needs the `Agent` type, and the SDK already imports types from
`@treeix/app`. `useAgents()` wraps it with
`useSyncExternalStore` over `subscribeSettings`, so an edit in Settings updates every list at once.

## Settings

One new field in `apps/desktop/src/renderer/src/settings.ts`:

```ts
/** Agents the user added or redefined, merged over BUILTIN_AGENTS by id */
customAgents: Agent[]
```

Parsed with a guard in the style of `parseKeymap` and `parseNavigationKeys`: a malformed entry is dropped,
a malformed array falls back to `[]`. Required fields are `id`, `label` and `command`; `mark` defaults to
`●`, `color` to `var(--color-foreground)`, `agent` to `true`.

Merging by id means redefining a built-in is free: a user whose `claude` lives at a different path, or who
wants different flags, adds a custom agent with id `claude`.

### UI

An `Agents` component added to `SECTION_EXTRAS.Terminal` in `SettingsView.tsx`, beside the existing
`Themes`, `Plugins` and `Tools` blocks. It lists every agent from `getAgents()`: built-ins read-only with
an "Override" action that seeds a custom copy, custom ones editable and removable. The form is one row per
field of `Agent`. `useSettingEntries` gains an entry so the palette can jump to it.

## Session start and resume

`packages/plugins/terminal/renderer/terminals.ts` loses its two vendor branches. Two pure exported
functions replace them, each taking the agent row rather than reading a global:

```ts
export function startCommand(agent: Agent, prompt?: string, agentSessionId?: string | null): string | undefined
export function resumeCommandFor(agent: Agent, meta: SessionMeta): string | undefined
```

`startCommand` joins, in order: `agent.command`, `sessionIdFlag` with the generated uuid when the agent has
that flag, and the prompt with `promptFlag` when a prompt is given. When `agent.command` is null the prompt
is the whole command line, which is how a shell session runs a one-off command today and must keep working.

`resumeCommandFor` substitutes `{id}` in `agent.resumeCommand` with `meta.agentSessionId`, and falls back to
`startCommand(agent)` when the agent has no `resumeCommand` or the session has no id. The `agentSessionId`
is generated at start for any agent with a `sessionIdFlag`, not just for `claude`.

`SessionMeta` and its localStorage shape do not change. `isSessionMeta` relaxes its `kind` test from the
three literals to `typeof candidate.kind === 'string'`.

## Unknown agents

A saved session whose agent the user has since deleted must not crash the list. `getAgent` returns
`undefined`, and every call site renders a fallback row: the stored `kind` as its label, `●` in the muted
foreground, and no restart. The session can still be deleted from history. This is the only new behaviour
in the change; everything else is a rename of existing logic.

## Removing `kind !== 'shell'`

Six sites test for "is this an agent" by excluding the shell. Each becomes `isAgent(session.kind)`:

- `apps/desktop/src/renderer/src/WorkspaceRail.tsx:24`
- `apps/desktop/src/renderer/src/App.tsx:966`
- `apps/desktop/src/renderer/src/SendButton.tsx:16` and `:128`
- `packages/plugins/terminal/renderer/TaskList.tsx:88`
- `packages/plugins/terminal/renderer/terminals.ts:187` (`detectStatus`)

## Hardcoded lists

Four places enumerate agents by literal and instead iterate `getAgents()`:

- `BranchDialog.tsx:194`, the `['none', 'shell', 'claude', 'codex']` row of start options
- `SendButton.tsx:199`, "New Claude session with comments" and its Codex twin, one entry per agent
- `App.tsx:535`, "Open as worktree with Claude", one entry per agent
- `terminal/renderer/index.tsx:483`, the "New X tab" palette entries, already iterating and only needing
  the new source
- `TaskList.tsx:169`, which paints a task badge with `SESSION_KINDS.claude.color`, uses the first agent
  present in the task instead

## Out of scope

- `usage-limits` and `plans` stay Claude and Codex specific. They parse those tools' own local files and
  have nothing generic to read from another agent.
- The tool registry in `terminal/main/index.ts:7` keeps checking versions of `claude` and `codex` only.
  Custom agents get no update check and no "not installed" warning beyond the shell's own error.
- No per-agent environment variables. `TREEIX_CLAUDE_SETTINGS` stays a fixed default set by the terminal
  plugin's main module, because only Claude reads it.

## Testing

Bun tests beside the code they cover, matching the existing files in `terminal/renderer`:

- `startCommand` and `resumeCommandFor` for all three built-ins and a custom agent, including the shell's
  null command with and without a prompt, and an agent with `resumeCommand` but no `sessionIdFlag`.
- Registry merge: a custom agent with a fresh id appends, one with a built-in id replaces.
- `parseCustomAgents` on a malformed array, a malformed entry and missing optional fields.

## Future: browser element comments

A later plugin will embed a browser view, let the user select a page element, and send it to the agent
comment queue. `addComment` is already in the SDK, and `Attachment` already carries a file path and a
thumbnail, so a cropped screenshot needs no new plumbing. Three things in
`apps/desktop/src/shared/comments.ts` will need widening when that work starts, and nothing before:

- `ReviewComment.kind` is a closed `'file' | 'reference'` union, validated by `isReviewComment`. It should
  become an open string with a table of known kinds, the same shape this document gives `SessionKind`.
- `filePath` is required and `commentLocation` always formats `path:lines`. A page element has a URL and a
  CSS selector instead, so the location needs to be produced per kind.
- `commentsPrompt` splits comments into references and "feedback on the code in <branch>". Feedback on a
  rendered page is a third category, and folding it into the code branch would send the agent looking for a
  selector in the diff.
