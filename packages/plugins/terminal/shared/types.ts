export type TerminalOptions = {
  cwd: string
  command?: string
  cols: number
  rows: number
  /** Opaque renderer data kept with the process so a reloaded window can rebuild its session */
  meta: string
  /** Reuses a restored session's id, so its tabs and history keep pointing at it */
  id?: string
}

export type LiveTerminal = { id: string; meta: string; output: string; exitCode: number | null; cols: number; rows: number }

/** What Claude Code's hooks report: `input` when it waits for the user, `working` otherwise */
/** `done`: the agent ended its turn */
export type AgentHookStatus = 'input' | 'working' | 'done'

/** A session's agent conversation, for reading its transcript */
export type TranscriptRef = { sessionId: string; kind: string; agentSessionId: string }

/** Tokens a conversation used: `input` is fresh input including cache writes, `cached` is input read from the cache; `costUsd` is Claude's own figure, when it reported one this run */
export type SessionUsage = { input: number; output: number; cached: number; costUsd?: number }
