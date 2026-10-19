import { type ComponentType, lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { createStore, type RendererPlugin, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { type Agent, useAgents } from '@treeix/app/agents'
import { subscribeSettings, useSettings } from '@treeix/app/settings'
import { notify } from '@treeix/app/notifications'
import { type AgentRuntime, isCodingAgent, isWaiting, type Run } from '../shared/workflow'
import { AskDialog } from './AskDialog'
import { Configure } from './Configure'
import { HubSettings } from './Settings'
import {
  asAgent,
  asking,
  chatIdOf,
  followAgents,
  followChats,
  followRuns,
  followTickets,
  followWorkflows,
  hubAgents,
  hubApi,
  hubEditing,
  hubRuns,
  followEvals,
  followAutopilot,
  hubAutopilot,
  hubSelection,
  hubSettings,
  hubWorkflows,
  onOpenRun,
  setAutopilot,
  TAB_ID
} from './store'

// The page pulls in the chat view and the canvas, so it loads when first opened
const HubPage = lazy(() => import('./HubPage').then((module) => ({ default: module.HubPage })))
// The editor only loads once an agent is being created or edited
const HubEditor = lazy(() => import('./HubPage').then((module) => ({ default: module.HubEditor })))

/** A bot as the Bots window lists it: what it is doing now, else its last conversation's first message */
export type BotSummary = {
  id: string
  name: string
  look: { color: string; mark: string }
  status: 'idle' | 'running' | 'attention'
  preview: string
  updatedAt: number | null
}

declare module '@treeix/sdk' {
  interface Services {
    /** Provided by the hub: its bots, last active first, and a bot's chat */
    bots: { list: () => BotSummary[]; subscribe: (listener: () => void) => () => void; Thread: ComponentType<{ botId: string }> }
  }
}

const noSubscription = (): (() => void) => () => undefined

// Root keeps it current, so the Bots window reads it without hooks of the hub's own
const botList = createStore<BotSummary[]>([])

function useBots(): BotSummary[] {
  const chat = useHost().service('chat')
  const agents = hubAgents.useValue()
  const { chats } = hubSettings.useValue()
  const statuses = useSyncExternalStore(chat?.subscribe ?? noSubscription, () => agents.map((agent) => chat?.status(chatIdOf(agent)) ?? 'idle').join(' ')).split(' ')
  return agents
    .map((agent, index): BotSummary => {
      const last = chats.find((entry) => entry.agentId === agent.id)
      const status = statuses[index] === 'input' ? 'attention' : statuses[index] === 'running' ? 'running' : 'idle'
      return {
        id: agent.id,
        name: agent.name,
        look: { color: agent.color, mark: agent.mark ?? '' },
        status,
        preview: status === 'attention' ? 'Needs you' : status === 'running' ? 'Working…' : (last?.title ?? 'No conversations yet'),
        updatedAt: last?.updatedAt ?? null
      }
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

const BotThread = lazy(() => import('./HubPage').then((module) => ({ default: module.BotThread })))

function Thread({ botId }: { botId: string }): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <BotThread botId={botId} />
    </Suspense>
  )
}

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <HubPage />
    </Suspense>
  )
}

/** Tells main how each agent chats, which only the registry here knows, so runs can start agents */
function useRuntimes(): void {
  'use no memo' // each agent's chat spec is read from the agent registry during render
  const host = useHost()
  const agents = hubAgents.useValue()
  const registry = useAgents()
  const { claudeSkipPermissions, codexSkipPermissions } = useSettings()
  const skips = { claude: claudeSkipPermissions, codex: codexSkipPermissions }
  const runtimes = [
    ...agents.flatMap((agent): AgentRuntime[] => {
      const chat = asAgent(agent)?.chat
      return chat ? [{ ...chat, agent: agent.id, cwd: agent.folder ?? host.defaultCwd }] : []
    }),
    // Steps on Claude or Codex as they are allow what their Settings switch lets them
    ...registry.flatMap((agent): AgentRuntime[] =>
      isCodingAgent(agent.id) && agent.chat ? [{ ...agent.chat, agent: agent.id, cwd: host.defaultCwd, autoApprove: skips[agent.id] }] : []
    )
  ]
  const key = JSON.stringify(runtimes)
  // Before the agents load the list is empty, which must not wipe what main saved
  useEffect(() => void (runtimes.length && hubApi.setRuntimes(runtimes)), [key])
}

const NOTICE: Partial<Record<string, string>> = { waiting: 'needs you', done: 'finished', failed: 'failed' }

/** Lights the hub's button when a run starts waiting on the user or ends; opening it shows the run */
function useRunNotifications(): void {
  const host = useHost()
  useEffect(
    () =>
      onOpenRun((runId) => {
        hubSelection.set(`run:${runId}`)
        host.setActiveTab(TAB_ID)
      }),
    [host]
  )
  useEffect(() => {
    const stateOf = (run: Run): string => (isWaiting(run) ? 'waiting' : run.status)
    let seen = new Map<string, string>()
    return hubRuns.subscribe(() => {
      const next = new Map(hubRuns.get().map((run) => [run.id, stateOf(run)]))
      // ponytail: every background window notifies; elect one window if several get noisy
      for (const run of hubRuns.get()) {
        const state = stateOf(run)
        const previous = seen.get(run.id)
        if (!previous || previous === state || !NOTICE[state] || run.kind === 'eval') continue
        notify({
          title: `${run.title} ${NOTICE[state]}`,
          body: 'Agents',
          // Main shows how a scheduled run ended itself, as the schedule asks
          system: !(run.kind === 'schedule' && state !== 'waiting'),
          failed: state === 'failed',
          open: () => {
            hubSelection.set(`run:${run.id}`)
            host.setActiveTab(TAB_ID)
          }
        })
      }
      seen = next
    })
  }, [host])
}

function Root(): React.JSX.Element {
  const chat = useHost().service('chat')
  const editing = hubEditing.useValue()
  useEffect(followAgents, [])
  useEffect(() => (chat ? followChats(chat) : undefined), [chat])
  useEffect(followWorkflows, [])
  useEffect(followRuns, [])
  useEffect(followTickets, [])
  useEffect(followEvals, [])
  useEffect(followAutopilot, [])
  useRuntimes()
  useRunNotifications()
  const bots = useBots()
  useEffect(() => botList.set(bots), [JSON.stringify(bots)])
  return (
    <>
      <AskDialog />
      {editing && (
        <Suspense fallback={null}>
          <HubEditor />
        </Suspense>
      )}
    </>
  )
}

/** Lit while a workflow or agent would start on its own; a click stops all of that, runs already going finish */
function Autopilot(): React.JSX.Element {
  const on = hubAutopilot.useValue()
  const workflows = hubWorkflows.useValue()
  const agents = hubAgents.useValue()
  const armed =
    workflows.some((workflow) =>
      workflow.nodes.some(
        (node) => node.kind === 'input' && (node.watches?.some((watch) => watch.enabled) || node.schedules?.some((schedule) => schedule.enabled) || Boolean(node.events?.length))
      )
    ) || agents.some((agent) => agent.schedules?.some((schedule) => schedule.enabled))
  const state = !on
    ? 'Autopilot is off: no workflow starts on its own'
    : armed
      ? 'Autopilot is on: workflows start on their watches, schedules and events'
      : 'Autopilot is on, but no workflow has a watch, schedule or event turned on'
  const title = `${state}. Click to turn it ${on ? 'off' : 'on'}`
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => void setAutopilot(!on)}
      className={`relative flex h-6 items-center rounded-md px-1.5 hover:bg-accent [-webkit-app-region:no-drag] ${
        !on ? 'text-muted-foreground/40' : armed ? 'bg-emerald-400/12 text-emerald-400' : 'bg-foreground/8 text-foreground'
      }`}
    >
      <Icon name="sparkles" className="size-3.5" />
      {!on && <span className="absolute top-1/2 left-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />}
    </button>
  )
}

const plugin: RendererPlugin = {
  tabs: [
    {
      id: TAB_ID,
      label: 'Agents',
      icon: 'sparkles',
      order: 30,
      render: Tab
    },
    { id: 'hub.configure', label: 'Configure', icon: 'settings', order: 31, render: Configure, hidden: true }
  ],
  Root,
  titleBar: [{ order: 0, render: Autopilot }],
  services: { bots: { list: botList.get, subscribe: botList.subscribe, Thread } },
  Settings: HubSettings,
  commands: () => [
    ...hubAgents.get().map((agent) => ({
      id: `hub.ask.${agent.id}`,
      group: 'Actions',
      label: `Ask ${agent.name}…`,
      icon: 'comment' as const,
      run: () => asking.set({ target: `agent:${agent.id}`, openRun: true })
    })),
    ...hubWorkflows.get().map((workflow) => ({
      id: `hub.run.${workflow.id}`,
      group: 'Actions',
      label: `Run ${workflow.name}…`,
      icon: 'wand' as const,
      run: () => asking.set({ target: `workflow:${workflow.id}`, openRun: true })
    }))
  ],
  // Personas join the new-tab menus and chats; a runtime from Settings can change under them, so settings count too
  agents: {
    list: () => hubAgents.get().flatMap((agent): Agent | Agent[] => asAgent(agent) ?? []),
    subscribe: (listener) => {
      const unfollow = [hubAgents.subscribe(listener), subscribeSettings(listener)]
      return () => unfollow.forEach((stop) => stop())
    }
  }
}

export default plugin
