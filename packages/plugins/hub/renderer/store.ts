import { type ChatOption, type ChatSpec, createBridge, createStore, definePluginSettings } from '@treeix/sdk'
import { type Agent, getAgent } from '@treeix/app/agents'
import { stringValues } from '@treeix/shared/json'
import { AGENT_PREFIX, type HubAgent, isHubAgent } from '../shared/types'

export const TAB_ID = 'hub'

const bridge = createBridge('hub')

export const hubApi = {
  agents: () => bridge.invoke<HubAgent[]>('agents'),
  save: (agent: HubAgent) => bridge.invoke<void>('saveAgent', agent),
  remove: (id: string) => bridge.invoke<void>('deleteAgent', id),
  /** The models and modes the runtime offers, from a throwaway session */
  detect: (spec: ChatSpec, cwd: string) => bridge.invoke<ChatOption[]>('detect', spec.adapter, spec.command, cwd)
}

export const hubAgents = createStore<HubAgent[]>([])

/** Loads the agents and follows changes from any window; returns the unfollow */
export function followAgents(): () => void {
  void hubApi.agents().then(hubAgents.set)
  return bridge.on('agents', (agents) => Array.isArray(agents) && hubAgents.set(agents.filter(isHubAgent)))
}

/** The last conversation of each agent, by hub agent id, so the page resumes it */
export const hubSettings = definePluginSettings('hub', (stored) => ({ conversations: stringValues(stored.conversations) }))

export const registryId = (agent: HubAgent): string => `${AGENT_PREFIX}${agent.id}`

/** The agent in the registry, chatting through its runtime with its own instructions and preset; null once the runtime is gone */
export function asAgent(agent: HubAgent): Agent | null {
  const base = getAgent(agent.runtime.agent)?.chat
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
