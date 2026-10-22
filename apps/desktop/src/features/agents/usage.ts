import type { AgentUsage, LimitWindowName, UsageLimits, UsageRow } from '../../ipc/api'

export type LimitAgent = keyof UsageLimits

export const WINDOW_LABEL: Record<LimitWindowName, string> = { fiveHour: '5-hour window', weekly: 'Week' }
const SHORT: Record<LimitWindowName, string> = { fiveHour: '5h', weekly: 'wk' }

/** Bar color the prototype uses: amber past 60%, red from 90% */
export const level = (percent: number) => (percent >= 90 ? 'err' : percent > 60 ? 'warn' : '')

/** `45m`, `1h 12m`, `3d 4h`; null when the reset time is unknown */
export function untilLabel(at: number | null, now = Date.now()) {
  if (at === null) return null
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

export interface PillPart {
  label: string
  percent: number
}

/** The title bar pill: Claude's limits (Codex when only it reports), the chosen window first */
export function pillParts(limits: UsageLimits | null, window: LimitWindowName): { agent: LimitAgent; main: PillPart; other: PillPart | null } | null {
  const agent = limits?.claude ? 'claude' : limits?.codex ? 'codex' : null
  const own = agent && limits?.[agent]
  if (!agent || !own) return null
  const other: LimitWindowName = window === 'weekly' ? 'fiveHour' : 'weekly'
  const part = (name: LimitWindowName) => {
    const w = own[name]
    return w ? { label: SHORT[name], percent: Math.round(w.usedPercent) } : null
  }
  const main = part(window) ?? part(other)
  if (!main) return null
  return { agent, main, other: main.label === SHORT[window] ? part(other) : null }
}

export const rowTokens = (r: UsageRow) => r.input + r.output + r.cacheRead + r.cacheWrite

/** API-equivalent dollars; prices are $ per million tokens, a model without a price counts 0 */
export function rowCost(r: UsageRow, prices: AgentUsage['prices']) {
  const p = prices[r.model]
  return p ? (r.input * p[0] + r.output * p[1] + r.cacheRead * p[2] + r.cacheWrite * p[3]) / 1e6 : 0
}

export interface Share {
  name: string
  tokens: number
  cost: number
}

export interface UsageSummary {
  cost: number
  tokens: number
  /** Every day of the range, oldest first, empty days included */
  days: Share[]
  /** Most tokens first */
  models: Share[]
  projects: Share[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The last `count` local days, today included */
export function summarize(usage: AgentUsage, count = 7, now = new Date()): UsageSummary {
  const dayNames = Array.from({ length: count }, (_, i) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - count + 1 + i)))
  const rows = usage.rows.filter((r) => r.day >= dayNames[0] && r.day <= dayNames[count - 1])
  const group = (key: (r: UsageRow) => string, seed: string[] = []) => {
    const map = new Map(seed.map((name) => [name, { name, tokens: 0, cost: 0 }]))
    for (const r of rows) {
      const share = map.get(key(r)) ?? { name: key(r), tokens: 0, cost: 0 }
      share.tokens += rowTokens(r)
      share.cost += rowCost(r, usage.prices)
      map.set(share.name, share)
    }
    return [...map.values()]
  }
  const byTokens = (a: Share, b: Share) => b.tokens - a.tokens
  const models = group((r) => r.model).sort(byTokens)
  return {
    cost: models.reduce((sum, m) => sum + m.cost, 0),
    tokens: models.reduce((sum, m) => sum + m.tokens, 0),
    days: group((r) => r.day, dayNames),
    models,
    projects: group((r) => r.project).sort(byTokens),
  }
}

export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format
export const usd = (n: number) => `$${n.toFixed(2)}`
