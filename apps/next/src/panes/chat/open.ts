import type { ChatAgent, SessionInfo } from '../../ipc/api'
import type { Command } from '../../lib/paletteSearch'
import type { ShellView } from '../../shell/Shell'
import { leaves, newTabId } from '../../shell/state'
import { errorText, forget } from './store'

/** A chat is a pane leaf `chat:<id>`; ptyd keeps it, so it is not a session */
const PREFIX = 'chat:'

export const chatLeaf = (id: string): string => `${PREFIX}${id}`
export const isChatLeaf = (id: string): boolean => id.startsWith(PREFIX)
export const leafChat = (leaf: string): string => leaf.slice(PREFIX.length)

type View = Pick<ShellView, 'api' | 'ui' | 'dispatch'>

/** Focuses the chat's pane, or opens it in a new tab */
export function openChat(view: View, id: string): void {
  const leaf = chatLeaf(id)
  if (view.ui.tabs.some((tab) => leaves(tab.root).includes(leaf))) view.dispatch({ type: 'focus', session: leaf })
  else view.dispatch({ type: 'open', session: leaf, tabId: newTabId() })
}

/** Starts a chat in `cwd`, or continues an agent session's conversation as a chat */
export async function newChat(view: View, agent: ChatAgent, cwd: string, resume: string | null = null): Promise<void> {
  const info = await view.api.chatCreate({ agent, cwd, resume, preset: null })
  openChat(view, info.id)
}

/** Closing the pane stops the agent; the conversation stays resumable from History */
export function closeChat(view: View, leaf: string): void {
  const id = leafChat(leaf)
  view.dispatch({ type: 'remove', session: leaf })
  forget(id)
  void view.api.chatClose(id).catch(() => undefined)
}

const AGENTS = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
] as const

/** Palette actions; `session` is the focused one, offered as a chat when it runs an agent */
export function chatCommands(view: ShellView, cwd: string, session: SessionInfo | undefined): Command[] {
  // ponytail: the shell has no toast yet; a failed start only logs
  const fail = (reason: unknown) => console.error(`Chat failed to start: ${errorText(reason)}`)
  const commands: Command[] = AGENTS.map(([agent, label]) => ({
    id: `chat-new-${agent}`,
    group: 'Actions',
    label: `New ${label} chat`,
    detail: cwd,
    icon: agent,
    run: () => void newChat(view, agent, cwd).catch(fail),
  }))
  const agent = session?.kind === 'claude' || session?.kind === 'codex' ? session.kind : null
  if (session && agent && session.agentSession)
    commands.push({ id: 'chat-continue', group: 'Actions', label: 'Continue as chat', detail: session.title, icon: agent, run: () => void newChat(view, agent, session.cwd, session.agentSession).catch(fail) })
  return commands
}
