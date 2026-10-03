# 6. AI Hub: personas and workflows

Date: 2026-10-03
Status: Proposed

## Context

Users want to define their own agents (name, look, model, instructions), chat with them and ping them, and chain them into multi-step workflows they can watch and rerun. Chat already runs agents through adapters (ADR 0003), but its connections belong to one window and there is no way to give an agent instructions or a model up front.

## Decision

- A `hub` plugin, off by default until complete, owns personas, workflows and runs. It requires the chat plugin.
- A persona is a runtime plus settings: an ACP agent from the registry (subscription CLIs such as Claude Code and Codex) or an OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio), with model, mode, instructions, folder and look. Personas join the agent registry through `RendererPlugin.agents` with ids `hub.<id>`; agents with only a chat command open as chats.
- `ChatSpec` gains `instructions` and `preset {model, mode}`. The ACP adapter appends instructions to the system prompt where the agent takes `_meta.systemPrompt` (claude-agent-acp), else puts them before the first message, and sets the preset through session options.
- Workflows are DAGs started by hand: input, agent, merge, condition, approval and output nodes, with `{{input}}`, `{{prev}}` and `{{nodes.<id>.output}}` templates. Several out-edges run in parallel.
- Runs execute in the hub's main process over `context.chatAdapter`, so they outlive a window reload and every window sees them. Run state and event logs live in the plugin's data folder.
- The canvas uses `@xyflow/react`, loaded lazily.

## Alternatives considered

- Workflows in the renderer through the chat service: rejected, a reload would kill running workflows.
- A persona as its own runtime with tool calling: rejected for v1, the subscription CLIs already bring tools and permissions.
- Scheduled and event triggers: left out; the trigger list is a union ready for them.

## Consequences

- One new dependency, `@xyflow/react`, in the hub's lazy chunk.
- API keys stay in main (safeStorage), keyed by origin; the renderer never sees them.
- Each agent node starts its agent afresh, which takes seconds per node.
