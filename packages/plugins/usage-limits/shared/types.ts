export type LimitWindow = {
  usedPercent: number
  /** Epoch milliseconds, null when unknown or already reset */
  resetsAt: number | null
}

export type AgentLimits = {
  fiveHour: LimitWindow | null
  weekly: LimitWindow | null
  /** When the numbers were captured, epoch milliseconds */
  updatedAt: number | null
}

export type UsageLimits = { claude: AgentLimits | null; codex: AgentLimits | null }
