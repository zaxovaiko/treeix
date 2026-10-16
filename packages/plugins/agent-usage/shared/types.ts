/** Tokens one agent spent on one model in one project on one local day */
export type UsageRow = {
  /** YYYY-MM-DD, local time */
  day: string
  agent: string
  model: string
  project: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** USD per token: input, output, cache read, cache write */
export type Price = [number, number, number, number]

export type AgentUsage = { rows: UsageRow[]; prices: Record<string, Price> }
