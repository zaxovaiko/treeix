import type { SessionStatus } from '@treeix/sdk'
import type { AgentHookStatus } from '../shared/types'

/** What an agent is doing right now; `watching` is a turn that ended with a shell, monitor or subagent left running */
export type AgentState = 'input' | 'running' | 'watching' | 'idle'

// ponytail: screen-scraped prompt detection for agents without hooks
const WAITING_FOR_INPUT = /Do you want to|❯\s*1\.\s*Yes|Yes, and don't ask|\[y\/n\]|\(y\/n\)|Allow command|Would you like to run|Press Enter to continue/i
/** Claude Code and Codex show this for as long as they work */
const WORKING = /esc to interrupt/i
// ponytail: screen-scraped, Claude's footer counts what it left running after its turn, e.g. "· 1 shell"; no hook reports it
const BACKGROUND_WORK = /·\s+\d+\s+(?:shell|monitor|agent|background task)s?\s*$/im
const FOOTER_ROWS = 3
const footer = (screen: string): string => screen.trimEnd().split('\n').slice(-FOOTER_ROWS).join('\n')

/**
 * Claude from its hooks, which report every change, so before the first one it sits at its prompt; other agents are read
 * off the screen. Never from output timing: a TUI redraws while it waits. A turn that ended leaving a shell or monitor
 * running is watching, not working.
 */
export function agentState(hooked: AgentHookStatus | undefined, hasHooks: boolean, screen: string): AgentState {
  if (hooked === 'input') return 'input'
  if (hooked === 'working') return 'running'
  if (hooked || hasHooks) return BACKGROUND_WORK.test(footer(screen)) ? 'watching' : 'idle'
  if (WAITING_FOR_INPUT.test(screen)) return 'input'
  return WORKING.test(screen) ? 'running' : 'idle'
}

/** A turn that ended while the session was out of sight shows as `done` until it comes on screen */
export function agentStatus(previous: SessionStatus, state: AgentState, finished: boolean, shown: boolean): SessionStatus {
  if (state !== 'idle') return state
  return !shown && (finished || previous === 'running' || previous === 'done') ? 'done' : 'idle'
}
