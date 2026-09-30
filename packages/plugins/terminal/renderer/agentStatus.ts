import type { SessionStatus } from '@treeix/sdk'
import type { AgentHookStatus } from '../shared/types'

/** What an agent is doing right now */
export type AgentState = 'input' | 'running' | 'idle'

// ponytail: screen-scraped prompt detection for agents without hooks
const WAITING_FOR_INPUT =
  /Do you want to|❯\s*1\.\s*Yes|Yes, and don't ask|\[y\/n\]|\(y\/n\)|Allow command|Would you like to run|Press Enter to continue/i
/** Claude Code and Codex show this for as long as they work */
const WORKING = /esc to interrupt/i

/**
 * Claude from its hooks, which report every change, so before the first one it sits at its prompt; other agents are read
 * off the screen. Never from output timing: a TUI redraws while it waits.
 */
export function agentState(hooked: AgentHookStatus | undefined, hasHooks: boolean, screen: string): AgentState {
  if (hooked) return hooked === 'input' ? 'input' : hooked === 'working' ? 'running' : 'idle'
  if (hasHooks) return 'idle'
  if (WAITING_FOR_INPUT.test(screen)) return 'input'
  return WORKING.test(screen) ? 'running' : 'idle'
}

/** A turn that ended while the session was out of sight shows as `done` until it comes on screen */
export function agentStatus(previous: SessionStatus, state: AgentState, finished: boolean, shown: boolean): SessionStatus {
  if (state !== 'idle') return state
  return !shown && (finished || previous === 'running' || previous === 'done') ? 'done' : 'idle'
}
