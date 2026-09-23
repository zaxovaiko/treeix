import { useSyncExternalStore } from 'react'
import { getSettings, subscribeSettings } from './settings'

export type Agent = {
  id: string
  label: string
  /** One glyph on the session's badge */
  mark: string
  color: string
  /** null runs the user's plain login shell */
  command: string | null
  /** Flag carrying the first prompt; an empty string passes it as a positional argument */
  promptFlag?: string
  /** Flag given a freshly generated conversation uuid, so a relaunch can resume exactly it */
  sessionIdFlag?: string
  /** Command that resumes a conversation; `{id}` is replaced with the session's uuid */
  resumeCommand?: string
  /** false only for the shell, which is a terminal rather than an agent */
  agent: boolean
  /** Chat through an adapter; agents without it are terminal only */
  chat?: { adapter: string; command: string }
}

/** The usage-limits plugin fills the variable with its status line bridge; the terminal plugin's main module defaults it to `{}` */
const CLAUDE = 'claude --settings "$TREEIX_CLAUDE_SETTINGS"'

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
    chat: { adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp@0.79.0' }
  },
  // ponytail: Codex can't be given an id up front, so relaunch resumes its latest conversation; read ~/.codex/sessions if two Codex sessions clash
  codex: {
    id: 'codex',
    label: 'Codex',
    mark: '◎',
    color: 'var(--color-foreground)',
    command: 'codex',
    promptFlag: '',
    resumeCommand: 'codex resume --last',
    agent: true,
    chat: { adapter: 'acp', command: 'npx -y @zed-industries/codex-acp@0.16.0' }
  },
  shell: { id: 'shell', label: 'Shell', mark: '$', color: '#34d399', command: null, agent: false }
} as const satisfies Record<string, Agent>

/** Built-ins first, then the user's; a custom agent sharing a built-in id replaces it in place */
let cache: { from: Agent[]; skip: boolean; list: Agent[] } | null = null
export function getAgents(): Agent[] {
  const { customAgents: custom, claudeSkipPermissions: skip } = getSettings()
  if (cache?.from !== custom || cache.skip !== skip) {
    const builtins = Object.values(BUILTIN_AGENTS).map((agent) => custom.find((entry) => entry.id === agent.id) ?? (skip && agent.id === 'claude' ? skippingPermissions(agent) : agent))
    cache = { from: custom, skip, list: [...builtins, ...custom.filter((entry) => !(entry.id in BUILTIN_AGENTS))] }
  }
  return cache.list
}

/** The built-in Claude with the Settings switch that lets it run every tool without asking */
const skippingPermissions = (agent: Agent): Agent => {
  const skipping = (command: string): string => command.replaceAll(CLAUDE, `${CLAUDE} --dangerously-skip-permissions`)
  return { ...agent, command: agent.command && skipping(agent.command), resumeCommand: agent.resumeCommand && skipping(agent.resumeCommand) }
}

export const getAgent = (id: string): Agent | undefined => getAgents().find((agent) => agent.id === id)

/** A session whose agent the user has deleted still has to render */
export const agentOr = (id: string): Agent => getAgent(id) ?? { id, label: id, mark: '●', color: 'var(--color-muted-foreground)', command: null, agent: false }

export const isAgent = (id: string): boolean => getAgent(id)?.agent ?? false

/** How an agent opens by default: the user's choice when it has a chat command, else the terminal */
export const viewFor = (agent: Agent, views: Record<string, 'chat' | 'terminal'>): 'chat' | 'terminal' =>
  agent.chat && views[agent.id] === 'chat' ? 'chat' : 'terminal'

export const useAgents = (): Agent[] => useSyncExternalStore(subscribeSettings, getAgents)

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
  return agentSessionId ? template.replaceAll('{id}', agentSessionId) : startCommand(agent, undefined, agentSessionId)
}
