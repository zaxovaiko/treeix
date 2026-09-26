# 3. Agent chat through adapters

Date: 2026-09-21
Status: Accepted

## Context

Agents only ran as TUIs in terminals. A chat view (streaming messages, tool calls as cards, permission prompts answered with a click, images, model and mode pickers) makes long sessions easier to follow, but it must not tie the core to Claude or Codex, and Treeix should hold no API keys: each agent runs as the user's own installed CLI with its own login and subscription.

## Decision

- `@treeix/sdk` declares a `ChatAdapter` contract and a `ChatEvent` model that mirrors the Agent Client Protocol's session updates. The chat core talks only to that contract.
- Plugins contribute adapters through `MainPlugin.chatAdapters`; the host collects them from enabled plugins.
- A `chat` plugin owns connections in main and the view, feed reducer and composer in the renderer. It ships one adapter, ACP, built on the official `@agentclientprotocol/sdk` over stdio. The ACP `terminal` capability is off; file system access goes through the host.
- An agent opts in with `Agent.chat = { adapter, command }` in the registry ([ADR 1](0001-agents-as-a-command-registry.md)). Custom agents can set a chat command too. Commands run through the user's login shell like terminal sessions.
- Chat sessions live in the terminal plugin's store as a discriminated union on `view: 'terminal' | 'chat'`, so groups, tabs, History, restore and workspaces work for both. The terminal plugin renders chat panes through the `chat` service.
- Transcripts stay in the agent's own storage. Treeix stores only session meta and resumes with ACP `session/load`.
- "Opens as" is a per-agent setting (`agentViews`) and defaults to Terminal. With the chat plugin off, chat sessions open in the terminal.
- Main batches events to the renderer every 50 ms. `feed.ts` is a pure reducer from events to turns and blocks, tested with recorded fixtures.

## Consequences

- A new agent needs a command, not code. A native adapter (Claude Agent SDK, `codex app-server`) can be added per agent later without touching the core.
- Chat features trail the CLIs: a new Claude Code feature appears in chat only once its ACP adapter supports it. The terminal stays one click away.
- "Open in terminal" only appears when an adapter reports `terminalCommand`; the ACP adapter does not yet, because chat and terminal session id parity is unverified.

Changes since the spec:

- No Gemini built-in shipped; Claude and Codex are the only chat presets.
- Presets run pinned adapters through `npx` (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`) instead of expecting a global install.
