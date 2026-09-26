# 1. Agents as a command registry

Date: 2026-09-20
Status: Accepted

## Context

Session kinds were compiled in: `SessionKind = 'claude' | 'codex' | 'shell'`, with vendor branches in the terminal plugin and hardcoded agent lists in several renderer files. Adding Aider, OpenCode or any other CLI meant editing the SDK and cutting a release, and users could not add an agent themselves. Everything an agent needs from Treeix is a handful of strings: a command, a flag for the first prompt, a flag for a conversation id, and a command to resume.

## Decision

- `SessionKind` in `@treeix/sdk` is an open `string`. A closed union cannot hold values typed into Settings at runtime, so the closed set moved from the type to a data table.
- `apps/desktop/src/renderer/src/agents.ts` owns the `Agent` shape, `BUILTIN_AGENTS` (Claude, Codex, Shell) and the lookups `getAgents`, `getAgent`, `agentOr`, `isAgent`, `useAgents`. It lives in the host, not the SDK, so the SDK has no runtime dependency on app code and there is no import cycle with `settings.ts`.
- Users add or redefine agents in Settings (`customAgents`). Entries merge over the built-ins by id, so overriding `claude` with a different path or flags needs no extra feature.
- `startCommand` and `resumeCommandFor` build command lines from an agent row. Resume is a `resumeCommand` template with `{id}`; there are no per-agent code paths or plugin hooks.
- The first prompt goes on the command line with a configurable flag, never typed into the TUI.
- Every `kind !== 'shell'` test became `isAgent(kind)`, and every literal agent list iterates `getAgents()`.
- A session whose agent was deleted renders through `agentOr` as a muted non-agent and reopens as a plain login shell in its worktree, which the existing "no command" path already did.

## Consequences

- No module outside the table knows a vendor's command line.
- Resuming a Claude session without a stored id now uses the same `claude --settings ...` as every other start, instead of a bare `claude` that dropped the usage-limits bridge.
- `usage-limits`, `plans` and the tool version checks stay Claude and Codex specific, since they read those tools' own files. Custom agents get no update check and no per-agent environment.

Changes since the plan:

- `startCommand` and `resumeCommandFor` live in `agents.ts`, not `terminals.ts`.
- Codex resumes by id (`codex resume {id}`), with the id discovered from `~/.codex/sessions` after start. A new `resumeLatestCommand` (`codex resume --last`) covers sessions whose id was never learned.
- The Settings switch `claudeSkipPermissions` rewrites the built-in Claude commands with its skip-permissions flag.
- `Agent.chat` was added later for the chat view (see [ADR 3](0003-agent-chat-through-adapters.md)).
