export type TerminalOptions = {
  cwd: string
  command?: string
  cols: number
  rows: number
  /** Opaque renderer data kept with the process so a reloaded window can rebuild its session */
  meta: string
}

export type LiveTerminal = { id: string; meta: string; output: string; exitCode: number | null; cols: number; rows: number }
