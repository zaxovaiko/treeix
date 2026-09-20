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
