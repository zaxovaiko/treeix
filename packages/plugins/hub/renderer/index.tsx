import { lazy, Suspense, useEffect } from 'react'
import { type RendererPlugin, useHost } from '@treeix/sdk'
import { type Agent, useAgents } from '@treeix/app/agents'
import { subscribeSettings } from '@treeix/app/settings'
import { notify } from '@treeix/app/notifications'
import { activeAgents, type AgentRuntime, isWaiting, type Run } from '../shared/workflow'
import { AskDialog } from './AskDialog'
import { asAgent, asking, followAgents, followRuns, followWorkflows, hubAgents, hubApi, hubRuns, hubSelection, hubWorkflows, onOpenRun, TAB_ID } from './store'

// The page pulls in the editor and the chat view, so it loads when first opened
const HubPage = lazy(() => import('./HubPage').then((module) => ({ default: module.HubPage })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <HubPage />
    </Suspense>
  )
}

/** Tells main how each agent chats, which only the registry here knows, so runs can start agents */
function useRuntimes(): void {
  const host = useHost()
  const agents = hubAgents.use()
  useAgents()
  const runtimes = agents.flatMap((agent): AgentRuntime[] => {
    const chat = asAgent(agent)?.chat
    return chat ? [{ ...chat, agent: agent.id, cwd: agent.folder ?? host.defaultCwd }] : []
  })
  const key = JSON.stringify(runtimes)
  // Before the agents load the list is empty, which must not wipe what main saved
  useEffect(() => void (runtimes.length && hubApi.setRuntimes(runtimes)), [key])
}

const NOTICE: Partial<Record<string, string>> = { waiting: 'needs you', done: 'finished', failed: 'failed' }

/** Into the notification center when a run starts waiting on the user or ends; opening it shows the run */
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
        if (!previous || previous === state || !NOTICE[state]) continue
        notify({
          title: `${run.title} ${NOTICE[state]}`,
          body: 'AI Hub',
          // Main shows how a scheduled run ended itself, as the schedule asks
          system: !(run.kind === 'schedule' && state !== 'waiting'),
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

/** How many agents are at work, and how many runs wait on the user */
function HubBadge(): React.JSX.Element | null {
  const runs = hubRuns.use()
  const active = activeAgents(runs).size
  const waiting = runs.filter(isWaiting).length
  if (!active && !waiting) return null
  return (
    <span className="flex items-center gap-2 text-muted-foreground tabular-nums">
      {active > 0 && (
        <span title={`${active} agent${active === 1 ? '' : 's'} working`} className="flex items-center gap-1">
          {active}
          <span className="size-1.5 rounded-full bg-emerald-400" />
        </span>
      )}
      {waiting > 0 && (
        <span title={`${waiting} run${waiting === 1 ? '' : 's'} waiting for you`} className="flex items-center gap-1">
          {waiting}
          <span className="size-1.5 rounded-full bg-amber-400" />
        </span>
      )}
    </span>
  )
}

function Root(): React.JSX.Element {
  useEffect(followAgents, [])
  useEffect(followWorkflows, [])
  useEffect(followRuns, [])
  useRuntimes()
  useRunNotifications()
  return <AskDialog />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'AI Hub', icon: 'sparkles', order: 30, render: Tab, panels: ['terminal'], Badge: HubBadge }],
  Root,
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
