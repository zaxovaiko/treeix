import { type ChatOption, type ChatSpec, createBridge, createStore, definePluginSettings } from '@treeix/sdk'
import { type Agent, getAgent } from '@treeix/app/agents'
import { parseJson, stringValues } from '@treeix/shared/json'
import { AGENT_PREFIX, API_PRESETS, type HubAgent, isHubAgent, type Runtime } from '../shared/types'
import { type AgentRuntime, isRun, isRunEvent, type Run, type RunEvent } from '../shared/workflow'

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
  cancelRun: (id: string) => bridge.send('cancelRun', id),
  answer: (runId: string, node: string, requestId: string, optionId: string) => bridge.send('answer', runId, node, requestId, optionId)
}

export const hubAgents = createStore<HubAgent[]>([])

/** Loads the agents and follows changes from any window; returns the unfollow */
export function followAgents(): () => void {
  void hubApi.agents().then(hubAgents.set)
  return bridge.on('agents', (agents) => Array.isArray(agents) && hubAgents.set(agents.filter(isHubAgent)))
}

export const hubRuns = createStore<Run[]>([])

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
/** What the page shows: `agent:<id>` or `run:<id>` */
export const hubSelection = createStore<string | null>(storedSelection())
hubSelection.subscribe(() => localStorage.setItem(SELECTED_KEY, JSON.stringify(hubSelection.get())))

/** The agent the Ask dialog is open for */
export const asking = createStore<string | null>(null)

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
    chat: { ...base, ...(agent.instructions.trim() ? { instructions: agent.instructions } : {}), preset }
  }
}
