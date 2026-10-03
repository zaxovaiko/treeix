import { lazy, Suspense, useEffect } from 'react'
import { type RendererPlugin, useHost } from '@treeix/sdk'
import { type Agent, useAgents } from '@treeix/app/agents'
import { subscribeSettings } from '@treeix/app/settings'
import type { AgentRuntime } from '../shared/workflow'
import { AskDialog } from './AskDialog'
import { asAgent, asking, followAgents, followRuns, hubAgents, hubApi, TAB_ID } from './store'

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

function Root(): React.JSX.Element {
  useEffect(followAgents, [])
  useEffect(followRuns, [])
  useRuntimes()
  return <AskDialog />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'AI Hub', icon: 'star', order: 30, render: Tab, panels: ['terminal'] }],
  Root,
  commands: () => hubAgents.get().map((agent) => ({ id: `hub.ask.${agent.id}`, group: 'Actions', label: `Ask ${agent.name}…`, icon: 'comment', run: () => asking.set(agent.id) })),
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
