import { useSyncExternalStore } from 'react'
import type { ChatSpec } from '@treeix/sdk'
import { getSettings, subscribeSettings } from './settings'

export type Agent = {
  id: string
  label: string
  /** One glyph on the session's badge */
  mark: string
  /** Picture to show instead of the glyph where there is room, e.g. the hub agent's avatar or alien */
  image?: string
  color: string
  /** null runs the user's plain login shell */
  command: string | null
  /** Flag carrying the first prompt; an empty string passes it as a positional argument */
  promptFlag?: string
  /** Flag given a freshly generated conversation uuid, so a relaunch can resume exactly it */
  sessionIdFlag?: string
  /** Command that resumes a conversation; `{id}` is replaced with the session's uuid */
  resumeCommand?: string
  /** Resumes the agent's latest conversation, for a session whose conversation id was never learned */
  resumeLatestCommand?: string
  /** false only for the shell, which is a terminal rather than an agent */
  agent: boolean
  /** Chat through an adapter; agents without it are terminal only */
  chat?: ChatSpec
  /** The plugin that manages it; such agents are edited there, not in Settings */
  plugin?: string
}

/**
 * The usage-limits plugin fills the settings with its status line bridge, and Treeix's MCP server adds itself; the terminal
 * plugin's main module gives both harmless defaults. --mcp-config takes several values, so a flag has to follow it.
 */
const CLAUDE = 'claude --mcp-config "$TREEIX_CLAUDE_MCP" --settings "$TREEIX_CLAUDE_SETTINGS"'
const CODEX = 'codex -c "$TREEIX_CODEX_MCP"'

export const BUILTIN_AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    mark: '✳',
    color: '#d97757',
    command: CLAUDE,
    promptFlag: '',
    sessionIdFlag: '--session-id',
    // A session closed before its first message has no transcript, and --resume would fail on it
    resumeCommand: `if ls ~/.claude/projects/*/{id}.jsonl >/dev/null 2>&1; then ${CLAUDE} --resume {id}; else ${CLAUDE} --session-id {id}; fi`,
    agent: true,
    chat: { adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp@0.85.1' }
  },
  // Codex can't be given an id up front; the terminal plugin finds it in ~/.codex/sessions after the session starts
  codex: {
    id: 'codex',
    label: 'Codex',
    mark: '◎',
    color: 'var(--color-foreground)',
    command: CODEX,
    promptFlag: '',
    resumeCommand: `${CODEX} resume {id}`,
    resumeLatestCommand: `${CODEX} resume --last`,
    agent: true,
    chat: { adapter: 'acp', command: 'npx -y @zed-industries/codex-acp@0.16.0' }
  },
  shell: { id: 'shell', label: 'Shell', mark: '$', color: '#34d399', command: null, agent: false }
} as const satisfies Record<string, Agent>

let pluginAgents: Agent[] = []
const pluginListeners = new Set<() => void>()

/** Agents enabled plugins manage, set by the plugin host */
export function setPluginAgents(agents: Agent[]): void {
  pluginAgents = agents
  pluginListeners.forEach((listener) => listener())
}

const subscribeAgents = (listener: () => void): (() => void) => {
  const unsubscribe = subscribeSettings(listener)
  pluginListeners.add(listener)
  return () => {
    unsubscribe()
    pluginListeners.delete(listener)
  }
}

/** Built-ins first, then the user's, then plugins'; a custom agent sharing a built-in id replaces it in place */
let cache: { from: Agent[]; plugins: Agent[]; skip: string; list: Agent[] } | null = null
export function getAgents(): Agent[] {
  const { customAgents: custom, claudeSkipPermissions, codexSkipPermissions } = getSettings()
  const skip = `${claudeSkipPermissions}:${codexSkipPermissions}`
  if (cache?.from !== custom || cache.plugins !== pluginAgents || cache.skip !== skip) {
    const skipped = (agent: Agent): Agent =>
      agent.id === 'claude' && claudeSkipPermissions
        ? skippingPermissions(agent, CLAUDE, '--dangerously-skip-permissions')
        : agent.id === 'codex' && codexSkipPermissions
          ? skippingPermissions(agent, CODEX, '--dangerously-bypass-approvals-and-sandbox')
          : agent
    const builtins = Object.values(BUILTIN_AGENTS).map((agent) => custom.find((entry) => entry.id === agent.id) ?? skipped(agent))
    const own = [...builtins, ...custom.filter((entry) => !(entry.id in BUILTIN_AGENTS))]
    cache = { from: custom, plugins: pluginAgents, skip, list: [...own, ...pluginAgents.filter((agent) => !own.some((entry) => entry.id === agent.id))] }
  }
  return cache.list
}

/** A built-in agent with the Settings switch that lets it run every tool without asking; `base` is how its commands start */
const skippingPermissions = (agent: Agent, base: string, flag: string): Agent => {
  const skipping = (command: string): string => command.replaceAll(base, `${base} ${flag}`)
  return {
    ...agent,
    command: agent.command && skipping(agent.command),
    resumeCommand: agent.resumeCommand && skipping(agent.resumeCommand),
    resumeLatestCommand: agent.resumeLatestCommand && skipping(agent.resumeLatestCommand)
  }
}

export const getAgent = (id: string): Agent | undefined => getAgents().find((agent) => agent.id === id)

/** A session whose agent the user has deleted still has to render */
export const agentOr = (id: string): Agent => getAgent(id) ?? { id, label: id, mark: '●', color: 'var(--color-muted-foreground)', command: null, agent: false }

export const isAgent = (id: string): boolean => getAgent(id)?.agent ?? false

/** The agent a new chat starts with: the one last picked, else the first that can chat */
export function chatAgent(): Agent | undefined {
  const agents = getAgents().filter((agent) => agent.chat)
  return agents.find((agent) => agent.id === getSettings().chatAgent) ?? agents[0]
}

export const useAgents = (): Agent[] => useSyncExternalStore(subscribeAgents, getAgents)

/** Has no terminal command, so it only opens as a chat */
export const isChatOnly = (agent: Agent): boolean => agent.command === null && agent.agent && agent.chat !== undefined

/** The command line that starts the agent, or undefined to drop the user into their shell */
export function startCommand(agent: Agent, prompt?: string, agentSessionId?: string | null): string | undefined {
  // A shell session takes the prompt as the command line to run
  if (!agent.command) return prompt
  const id = agent.sessionIdFlag && agentSessionId ? ` ${agent.sessionIdFlag} ${agentSessionId}` : ''
  const first = prompt ? ` ${agent.promptFlag ? `${agent.promptFlag} ` : ''}${prompt}` : ''
  return `${agent.command}${id}${first}`
}

export function resumeCommandFor(agent: Agent, agentSessionId: string | null): string | undefined {
  const template = agent.resumeCommand
  if (!template) return startCommand(agent, undefined, agentSessionId)
  if (!template.includes('{id}')) return template
  return agentSessionId ? template.replaceAll('{id}', agentSessionId) : (agent.resumeLatestCommand ?? startCommand(agent, undefined, agentSessionId))
}
