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
    agent: true
  },
  // ponytail: Codex can't be given an id up front, so relaunch resumes its latest conversation; read ~/.codex/sessions if two Codex sessions clash
  codex: { id: 'codex', label: 'Codex', mark: '◎', color: 'var(--color-foreground)', command: 'codex', promptFlag: '', resumeCommand: 'codex resume --last', agent: true },
  shell: { id: 'shell', label: 'Shell', mark: '$', color: '#34d399', command: null, agent: false }
} as const satisfies Record<string, Agent>

/** Built-ins first, then the user's; a custom agent sharing a built-in id replaces it in place */
export function getAgents(): Agent[] {
  const custom = getSettings().customAgents
  const builtins = Object.values(BUILTIN_AGENTS).map((agent) => custom.find((entry) => entry.id === agent.id) ?? agent)
  return [...builtins, ...custom.filter((entry) => !(entry.id in BUILTIN_AGENTS))]
}

export const getAgent = (id: string): Agent | undefined => getAgents().find((agent) => agent.id === id)

/** A session whose agent the user has deleted still has to render */
export const agentOr = (id: string): Agent => getAgent(id) ?? { id, label: id, mark: '●', color: 'var(--color-muted-foreground)', command: null, agent: false }

export const isAgent = (id: string): boolean => getAgent(id)?.agent ?? false

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
