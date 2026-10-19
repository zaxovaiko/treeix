import { type ChatOption, type ChatService, type ChatSpec, createBridge, createStore, definePluginSettings, type HostApi } from '@treeix/sdk'
import { errorMessage } from '@treeix/app/ui'
import { type Agent, getAgent } from '@treeix/app/agents'
import { parseJson, stringValues } from '@treeix/shared/json'
import { AGENT_PREFIX, API_PRESETS, type DecisionSettings, type HubAgent, isHubAgent, isRemoteStatus, type RemoteStatus, type Runtime } from '../shared/types'
import type { LocalModelsState } from '../shared/catalog'
import { type EvalResult, type EvalSuite, isEvalResult, isEvalSuite } from '../shared/evals'
import type { Subagent } from '../shared/subagents'
import { isTicketState, type TicketState } from '../shared/tickets'
import { type AgentRuntime, isRun, isRunEvent, isWorkflow, type Run, type RunEvent, type TicketDetail, type TicketSource, type Workflow } from '../shared/workflow'

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
  removeRun: (id: string) => bridge.invoke<void>('deleteRun', id),
  /** Starts a recorded one-off question; resolves with the run id */
  ask: (agent: string, message: string) => bridge.invoke<string>('ask', agent, message),
  /** The subagents the agent's folder and the workflow's projects define, which a workflow step can run as */
  subagents: (agent: string, projects: string[] = []) => bridge.invoke<Subagent[]>('subagents', agent, projects),
  /** The subagents a folder (the home folder when null) and the user's own config define, for a bot to start from */
  folderSubagents: (folder: string | null) => bridge.invoke<Subagent[]>('folderSubagents', folder),
  readSubagent: (path: string) => bridge.invoke<{ instructions: string; model: string | null } | null>('readSubagent', path),
  workflows: () => bridge.invoke<Workflow[]>('workflows'),
  saveWorkflow: (workflow: Workflow) => bridge.invoke<void>('saveWorkflow', workflow),
  removeWorkflow: (id: string) => bridge.invoke<void>('deleteWorkflow', id),
  /** Starts a run of the saved workflow; resolves with the run id */
  runWorkflow: (id: string, input: string) => bridge.invoke<string>('runWorkflow', id, input),
  cancelRun: (id: string) => bridge.send('cancelRun', id),
  answer: (runId: string, node: string, requestId: string, optionId: string) => bridge.send('answer', runId, node, requestId, optionId),
  /** Lets an approval step through, or rejects it and fails the run */
  decide: (runId: string, node: string, approved: boolean, reason: string | null = null) => bridge.send('decide', runId, node, approved, reason),
  /** Runs an ended run again from the step */
  retry: (runId: string, node: string) => bridge.invoke<void>('retryRun', runId, node),
  resume: (runId: string) => bridge.invoke<void>('resumeRun', runId),
  /** Whether runs the last quit cut short resume on launch */
  autoResume: () => bridge.invoke<boolean>('autoResume'),
  setAutoResume: (on: boolean) => bridge.invoke<void>('setAutoResume', on),
  /** Who answers a waiting step when nobody does, and when */
  decisionSettings: () => bridge.invoke<DecisionSettings>('decisionSettings'),
  setDecisionSettings: (settings: DecisionSettings) => bridge.invoke<void>('setDecisionSettings', settings),
  ticket: (source: TicketSource, key: string) => bridge.invoke<TicketDetail>('ticket', source, key),
  /** Changes only what is given */
  editTicket: (source: TicketSource, key: string, changes: { title?: string; body?: string }) => bridge.invoke<string>('editTicket', source, key, changes),
  /** Comments on the ticket itself, where its workflow's agents read it */
  commentTicket: (source: TicketSource, key: string, body: string) => bridge.invoke<string>('commentTicket', source, key, body),
  remote: () => bridge.invoke<RemoteStatus>('remote'),
  setRemote: (on: boolean) => bridge.invoke<void>('setRemote', on),
  /** How many devices the test notification reached */
  testPush: () => bridge.invoke<number>('testPush'),
  forgetDevices: () => bridge.invoke<void>('forgetDevices'),
  onRemote: (listener: (status: RemoteStatus) => void) => bridge.on('remote', (status) => isRemoteStatus(status) && listener(status)),
  localModels: () => bridge.invoke<LocalModelsState>('localModels'),
  pullModel: (id: string) => bridge.invoke<void>('pullModel', id),
  cancelPull: (id: string) => bridge.invoke<void>('cancelPull', id),
  deleteModel: (id: string) => bridge.invoke<void>('deleteModel', id),
  longContext: (id: string) => bridge.invoke<void>('longContext', id),
  evalSuites: () => bridge.invoke<EvalSuite[]>('evalSuites'),
  saveEvalSuite: (suite: EvalSuite) => bridge.invoke<void>('saveEvalSuite', suite),
  removeEvalSuite: (id: string) => bridge.invoke<void>('deleteEvalSuite', id),
  evalResults: (id: string) => bridge.invoke<EvalResult[]>('evalResults', id),
  /** Starts every case; rejects when the suite can't start */
  runEvalSuite: (id: string) => bridge.invoke<void>('runEvalSuite', id),
  /** Adds the finished run as a case of its workflow's or agent's suite; resolves with the suite id */
  saveEvalCase: (runId: string) => bridge.invoke<string>('saveEvalCase', runId),
  /** Each case's result as it comes in */
  onEvalResult: (listener: (suite: string, result: EvalResult) => void) =>
    bridge.on('evalResult', (suite, result) => typeof suite === 'string' && isEvalResult(result) && listener(suite, result)),
  /** Download progress of a model, in percent */
  onPull: (listener: (id: string, percent: number) => void) => bridge.on('pull', (id, percent) => typeof id === 'string' && typeof percent === 'number' && listener(id, percent))
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

export const hubSuites = createStore<EvalSuite[]>([])
/** Ids of the suites running now */
export const hubEvalsRunning = createStore<string[]>([])

export function followEvals(): () => void {
  void hubApi.evalSuites().then(hubSuites.set)
  void bridge.invoke<string[]>('evalsRunning').then(hubEvalsRunning.set)
  const unfollowSuites = bridge.on('evalSuites', (suites) => Array.isArray(suites) && hubSuites.set(suites.filter(isEvalSuite)))
  const unfollowRunning = bridge.on('evalsRunning', (ids) => Array.isArray(ids) && hubEvalsRunning.set(ids.filter((id): id is string => typeof id === 'string')))
  return () => (unfollowSuites(), unfollowRunning())
}

export const hubRuns = createStore<Run[]>([])

/** What the pull request watcher knows of each ticket */
export const hubTicketStates = createStore<TicketState[]>([])

export function followTickets(): () => void {
  void bridge.invoke<TicketState[]>('tickets').then(hubTicketStates.set)
  return bridge.on('tickets', (states) => Array.isArray(states) && hubTicketStates.set(states.filter(isTicketState)))
}

/** Whether workflows and agents start on their own: schedules, watches, events, pull request follow-ups */
export const hubAutopilot = createStore(true)

export function followAutopilot(): () => void {
  void bridge.invoke<boolean>('autopilot').then(hubAutopilot.set)
  return bridge.on('autopilot', (on) => typeof on === 'boolean' && hubAutopilot.set(on))
}

export const setAutopilot = (on: boolean): Promise<void> => bridge.invoke<void>('setAutopilot', on)

/** Clicks on main's notifications for scheduled runs; returns the unfollow */
export const onOpenRun = (listener: (runId: string) => void): (() => void) => bridge.on('openRun', (id) => typeof id === 'string' && listener(id))

export function followRuns(): () => void {
  void hubApi.runs().then(hubRuns.set)
  const unfollowRun = bridge.on('run', (run) => isRun(run) && hubRuns.set([run, ...hubRuns.get().filter((entry) => entry.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt)))
  const unfollowRemoved = bridge.on('runRemoved', (id) => hubRuns.set(hubRuns.get().filter((run) => run.id !== id)))
  return () => (unfollowRun(), unfollowRemoved())
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
/** What the page shows: `agent:<id>`, `workflow:<id>`, `run:<id>` or `ticket:<key>` */
export const hubSelection = createStore<string | null>(storedSelection())
hubSelection.subscribe(() => localStorage.setItem(SELECTED_KEY, JSON.stringify(hubSelection.get())))

/** What was shown before, newest last, for Back; the board is null */
const visited: (string | null)[] = []
let shown = hubSelection.get()
let goingBack = false
hubSelection.subscribe(() => {
  const next = hubSelection.get()
  if (next === shown) return
  if (!goingBack && visited.push(shown) > 50) visited.shift()
  shown = next
})
/** Shows what was on screen before, the board when nothing was */
export function hubBack(): void {
  goingBack = true
  hubSelection.set(visited.pop() ?? null)
  goingBack = false
}
/** The agent the editor dialog is on, `new` for one being created */
export const hubEditing = createStore<HubAgent | 'new' | null>(null)

/** `<run>:<step>`, the step a run opens on when the canvas asks for its log */
export const hubRunStep = createStore<string | null>(null)

/** What the Ask dialog starts, `agent:<id>` or `workflow:<id>`, and whether the run's page opens after */
export const asking = createStore<{ target: string; openRun: boolean } | null>(null)

/** A conversation with a hub agent, kept so it can be opened again */
export type HubChat = { sessionId: string; agentId: string; title: string; updatedAt: number }

const isHubChat = (value: unknown): value is HubChat =>
  typeof value === 'object' &&
  value !== null &&
  'sessionId' in value &&
  typeof value.sessionId === 'string' &&
  'agentId' in value &&
  typeof value.agentId === 'string' &&
  'title' in value &&
  typeof value.title === 'string' &&
  'updatedAt' in value &&
  typeof value.updatedAt === 'number'

/** The last conversation of each agent, by hub agent id, so the page resumes it, and every conversation that got a message, newest first */
export const hubSettings = definePluginSettings('hub', (stored) => ({
  conversations: stringValues(stored.conversations),
  chats: Array.isArray(stored.chats) ? stored.chats.filter(isHubChat) : []
}))

const ACTIVE_MS = 60_000

/** Puts each hub agent's chat in the history once it has a message, and bumps it while the agent works; returns the unfollow */
export function followChats(chat: ChatService): () => void {
  const record = (): void => {
    let { chats } = hubSettings.get()
    for (const agent of hubAgents.get()) {
      const chatId = chatIdOf(agent)
      const sessionId = chat.agentSessionId(chatId)
      const title = chat.title(chatId)
      if (!sessionId || !title) continue
      // A chat armed with no conversation gets one when its first message starts the agent
      if (hubSettings.get().conversations[agent.id] !== sessionId) setConversation(agent.id, sessionId)
      const known = chats.find((entry) => entry.sessionId === sessionId)
      const working = chat.status(chatId) === 'running'
      if (known && known.title === title && !(working && Date.now() - known.updatedAt > ACTIVE_MS)) continue
      chats = [{ sessionId, agentId: agent.id, title, updatedAt: Date.now() }, ...chats.filter((other) => other.sessionId !== sessionId)]
    }
    if (chats !== hubSettings.get().chats) hubSettings.update({ chats })
  }
  record()
  return chat.subscribe(record)
}

export const chatIdOf = (agent: HubAgent): string => `hub:${agent.id}`

/** After a confirm: stops its chat, drops its conversations and removes it */
export function deleteAgent(host: HostApi, target: HubAgent): void {
  if (!window.confirm(`Delete ${target.name}?`)) return
  const service = host.service('chat')
  service?.stop(chatIdOf(target))
  service?.forget(chatIdOf(target))
  setConversation(target.id, null)
  hubSettings.update({ chats: hubSettings.get().chats.filter((entry) => entry.agentId !== target.id) })
  hubApi.remove(target.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
}

/** The conversation the agent's chat picks up when it next opens; null starts a new one */
export const setConversation = (agentId: string, sessionId: string | null): void => {
  const others = Object.fromEntries(Object.entries(hubSettings.get().conversations).filter(([id]) => id !== agentId))
  hubSettings.update({ conversations: sessionId ? { ...others, [agentId]: sessionId } : others })
}

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
  const preset = { ...(agent.model && { model: agent.model }), ...(agent.effort && { effort: agent.effort }) }
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
