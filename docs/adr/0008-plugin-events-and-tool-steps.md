# 8. Plugin events and tool steps

Date: 2026-10-14
Status: Accepted

## Context

Meeting recording, Slack and Notion move into Treeix from a separate app (MeetApp). That app hardcoded the chain: a transcript went to one local model with one prompt, then to two fixed Notion databases; Slack messages went the same way. In Treeix each of those has to be configurable by any user, and the AI Hub already runs configurable chains: workflows with agent steps on any runtime, Ollama included, plus retry from the failed step.

Main-side plugins couldn't reach each other: no events, and the MCP tools they register could only be called by agents.

## Decision

- Plugins produce, workflows wire. A producer (meetings, slack) emits an event and exposes MCP tools; it holds no model or destination code. A destination (notion) is just an MCP tool.
- `MainContext` gains:
  - `emit(name, payload): Promise<boolean>`. The host prefixes the plugin id (`meetings.transcribed`). True when some listener took it, so a producer keeps its data until then (Slack's pending file).
  - `onEvent(listener)`, disposed with the plugin. A listener that throws counts as not taken.
  - `callTool(name, args): Promise<string>`, any registered MCP tool in-process. A tool error throws.
- `@treeix/host/secrets` `createSecrets(path)`: named secrets encrypted with `safeStorage` in a 0600 file, the hub's API keys store generalized for every plugin's tokens.
- Hub:
  - An input step lists `events`; each matching event starts a run with the JSON payload as its input, titled from `payload.title`. A run started this way that fails notifies, since nobody watched it start.
  - A `tool` step: `{tool, args}`, args a JSON template. A string leaf that is only `{{reference}}` takes the value as is, so an agent step answering JSON can pass lists and objects; other leaves interpolate.
  - References take dotted paths into JSON (`{{input.title}}`, `{{nodes.notes.output.tasks}}`). An output is parsed leniently: JSON inside prose or a code fence counts.

## Alternatives considered

- Each plugin calling Ollama and Notion itself, as MeetApp did: rejected, a second model path and fixed destinations.
- A `forEach` step for one page per task: left out, `notion_create_pages` takes a batch.
- A shell step: left out, templates filled from a transcript or a Slack message would become commands.

## Consequences

- Durability is the run's: a step that fails is retried from that step, earlier steps aren't redone, so Notion pages aren't duplicated.
- A workflow is the only consumer; with the hub off, events go unheard and producers keep their data.
- A tool step can call any tool Treeix has, including ones that write; workflows are the user's own, like agent steps with auto-approve.
