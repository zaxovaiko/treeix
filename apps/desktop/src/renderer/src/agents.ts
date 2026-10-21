import { useSyncExternalStore } from 'react'
import type { ChatSpec } from '@treeix/sdk'
import { getSettings, subscribeSettings } from './settings'

export type Agent = {
  id: string
  label: string
  /** One glyph on the session's badge */
  mark: string
  /** Claude's and Codex's logos, an svg path in a 24 box, drawn instead of the glyph while it stays the built-in one */
  logo?: string
  /** Picture to show instead of the glyph where there is room, e.g. the hub agent's avatar */
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
    logo: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z',
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
    logo: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z',
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
    // A cleared field in Settings still needs something to show in menus and badges
    const named = (agent: Agent): Agent => ({
      ...agent,
      label: agent.label.trim() || 'Unnamed agent',
      mark: agent.mark.trim() || '●',
      color: agent.color.trim() || 'var(--color-foreground)'
    })
    const own = [...builtins, ...custom.filter((entry) => !(entry.id in BUILTIN_AGENTS))].map(named)
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

/** The built-in's logo for an agent still wearing the built-in's mark; a mark changed in Settings shows instead */
export const logoOf = (agent: Agent): string | null => {
  const builtin = Object.values(BUILTIN_AGENTS).find((entry) => entry.id === agent.id)
  return builtin && 'logo' in builtin && builtin.mark === agent.mark ? builtin.logo : null
}

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
