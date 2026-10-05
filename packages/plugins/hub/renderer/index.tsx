import { lazy, Suspense, useEffect } from 'react'
import { type RendererPlugin, useHost } from '@treeix/sdk'
import { type Agent, useAgents } from '@treeix/app/agents'
import { subscribeSettings } from '@treeix/app/settings'
import { notify } from '@treeix/app/notifications'
import { type AgentRuntime, isWaiting, type Run } from '../shared/workflow'
import { AskDialog } from './AskDialog'
import { HubFace, HubPeek } from './Peek'
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
        if (!previous || previous === state || !NOTICE[state]) continue
        notify({
          title: `${run.title} ${NOTICE[state]}`,
          body: 'AI Hub',
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
  useEffect(followAgents, [])
  useEffect(followWorkflows, [])
  useEffect(followRuns, [])
  useRuntimes()
  useRunNotifications()
  return <AskDialog />
}

const plugin: RendererPlugin = {
  tabs: [
    {
      id: TAB_ID,
      label: 'AI Hub',
      icon: 'sparkles',
      order: 30,
      render: Tab,
      overlay: { Face: HubFace, Peek: HubPeek }
    }
  ],
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
