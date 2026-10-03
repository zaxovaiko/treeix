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

/** What sits next to Treeix's icon in the macOS menu bar */
export const MENU_BAR_LABELS = ['weekly', 'fiveHour', 'rings', 'icon'] as const
export type MenuBarLabel = (typeof MENU_BAR_LABELS)[number]
export const isMenuBarLabel = (value: unknown): value is MenuBarLabel => MENU_BAR_LABELS.some((label) => label === value)
