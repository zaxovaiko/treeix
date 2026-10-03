import { lazy, Suspense, useEffect } from 'react'
import type { RendererPlugin } from '@treeix/sdk'
import type { Agent } from '@treeix/app/agents'
import { subscribeSettings } from '@treeix/app/settings'
import { asAgent, followAgents, hubAgents, TAB_ID } from './store'

// The page pulls in the editor and the chat view, so it loads when first opened
const HubPage = lazy(() => import('./HubPage').then((module) => ({ default: module.HubPage })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <HubPage />
    </Suspense>
  )
}

function Root(): null {
  useEffect(followAgents, [])
  return null
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'AI Hub', icon: 'star', order: 30, render: Tab, panels: ['terminal'] }],
  Root,
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
