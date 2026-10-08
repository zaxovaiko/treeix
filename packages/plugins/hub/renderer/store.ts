import { type ChatOption, type ChatSpec, createBridge, createStore, definePluginSettings } from '@treeix/sdk'
import { type Agent, getAgent } from '@treeix/app/agents'
import { parseJson, stringValues } from '@treeix/shared/json'
import { AGENT_PREFIX, API_PRESETS, type HubAgent, isHubAgent, type Runtime } from '../shared/types'
import { type AgentRuntime, isRun, isRunEvent, isWorkflow, type Run, type RunEvent, type Workflow } from '../shared/workflow'

export const TAB_ID = 'hub'

const bridge = createBridge('hub')

export const hubApi = {
  agents: () => bridge.invoke<HubAgent[]>('agents'),
  save: (agent: HubAgent) => bridge.invoke<void>('saveAgent', agent),
  remove: (id: string) => bridge.invoke<void>('deleteAgent', id),
  /** The models and modes the runtime offers, from a throwaway session */
  detect: (spec: ChatSpec, cwd: string) => bridge.invoke<ChatOption[]>('detect', spec.adapter, spec.command, cwd),
  hasKey: (baseUrl: string) => bridge.invoke<boolean>('hasKey', baseUrl),
  setKey: (baseUrl: string, key: string | null) => bridge.invoke<void>('setKey', baseUrl, key),
  setRuntimes: (runtimes: AgentRuntime[]) => bridge.invoke<void>('setRuntimes', runtimes),
  runs: () => bridge.invoke<Run[]>('runs'),
  runEvents: (id: string) => bridge.invoke<RunEvent[]>('runEvents', id),
  /** Starts a recorded one-off question; resolves with the run id */
  ask: (agent: string, message: string) => bridge.invoke<string>('ask', agent, message),
  workflows: () => bridge.invoke<Workflow[]>('workflows'),
  saveWorkflow: (workflow: Workflow) => bridge.invoke<void>('saveWorkflow', workflow),
  removeWorkflow: (id: string) => bridge.invoke<void>('deleteWorkflow', id),
  /** Starts a run of the saved workflow; resolves with the run id */
  runWorkflow: (id: string, input: string) => bridge.invoke<string>('runWorkflow', id, input),
  cancelRun: (id: string) => bridge.send('cancelRun', id),
  answer: (runId: string, node: string, requestId: string, optionId: string) => bridge.send('answer', runId, node, requestId, optionId),
  /** Lets an approval step through, or rejects it and fails the run */
  decide: (runId: string, node: string, approved: boolean) => bridge.send('decide', runId, node, approved),
  /** Runs an ended run again from the step */
  retry: (runId: string, node: string) => bridge.invoke<void>('retryRun', runId, node)
}

export const hubAgents = createStore<HubAgent[]>([])

/** Loads the agents and follows changes from any window; returns the unfollow */
export function followAgents(): () => void {
  void hubApi.agents().then(hubAgents.set)
  return bridge.on('agents', (agents) => Array.isArray(agents) && hubAgents.set(agents.filter(isHubAgent)))
}

export const hubWorkflows = createStore<Workflow[]>([])

export function followWorkflows(): () => void {
  void hubApi.workflows().then(hubWorkflows.set)
  return bridge.on('workflows', (workflows) => Array.isArray(workflows) && hubWorkflows.set(workflows.filter(isWorkflow)))
}

export const hubRuns = createStore<Run[]>([])

/** Clicks on main's notifications for scheduled runs; returns the unfollow */
export const onOpenRun = (listener: (runId: string) => void): (() => void) => bridge.on('openRun', (id) => typeof id === 'string' && listener(id))

export function followRuns(): () => void {
  void hubApi.runs().then(hubRuns.set)
  return bridge.on('run', (run) => isRun(run) && hubRuns.set([run, ...hubRuns.get().filter((entry) => entry.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt)))
}

/** A run's events so far, then each batch as it streams; batches that arrive before the load are already in it */
export function followRunEvents(runId: string, onChange: (events: RunEvent[]) => void): () => void {
  let events: RunEvent[] | null = null
  let following = true
  const unfollow = bridge.on('events', (id, batch) => {
    if (id !== runId || !events || !Array.isArray(batch)) return
    events = [...events, ...batch.filter(isRunEvent)]
    onChange(events)
  })
  void hubApi.runEvents(runId).then((loaded) => {
    if (!following) return
    events = loaded
    onChange(loaded)
  })
  return () => {
    following = false
    unfollow()
  }
}

const SELECTED_KEY = 'hub.selected'
const storedSelection = (): string | null => {
  const value = parseJson(localStorage.getItem(SELECTED_KEY))
  return typeof value === 'string' ? value : null
}
/** What the page shows: `agent:<id>`, `workflow:<id>` or `run:<id>` */
export const hubSelection = createStore<string | null>(storedSelection())
hubSelection.subscribe(() => localStorage.setItem(SELECTED_KEY, JSON.stringify(hubSelection.get())))

/** What the Ask dialog starts, `agent:<id>` or `workflow:<id>`, and whether the run's page opens after */
export const asking = createStore<{ target: string; openRun: boolean } | null>(null)

/** The last conversation of each agent, by hub agent id, so the page resumes it */
export const hubSettings = definePluginSettings('hub', (stored) => ({ conversations: stringValues(stored.conversations) }))

export const registryId = (agent: HubAgent): string => `${AGENT_PREFIX}${agent.id}`

/** How the runtime chats; null once a registry agent it ran on is gone */
export const runtimeSpec = (runtime: Runtime): ChatSpec | null =>
  runtime.kind === 'api' ? { adapter: 'openai', command: runtime.baseUrl } : (getAgent(runtime.agent)?.chat ?? null)

export function runtimeLabel(runtime: Runtime): string {
  if (runtime.kind === 'agent') return getAgent(runtime.agent)?.label ?? runtime.agent
  return API_PRESETS.find((preset) => preset.baseUrl === runtime.baseUrl)?.name ?? runtime.baseUrl.replace(/^https?:\/\//, '')
}

/** The agent in the registry, chatting through its runtime with its own instructions and preset; null once the runtime is gone */
export function asAgent(agent: HubAgent): Agent | null {
  const base = runtimeSpec(agent.runtime)
  if (!base) return null
  const preset = { ...(agent.model ? { model: agent.model } : {}), ...(agent.mode ? { mode: agent.mode } : {}) }
  return {
    id: registryId(agent),
    label: agent.name,
    mark: agent.icon,
    color: agent.color,
    command: null,
    agent: true,
    chat: { ...base, ...(agent.instructions.trim() ? { instructions: agent.instructions } : {}), ...(agent.directories?.length ? { directories: agent.directories } : {}), preset }
  }
}
