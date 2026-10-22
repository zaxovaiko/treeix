import type { AgentUsage, Api, UsageLimits, UsageRow } from './api'

// Phase 4 agents demo data (owner A3/U5): usage rows, plan limits, ports of the seeded sessions

type AgentsApi = Pick<Api, 'agentUsage' | 'usageLimits' | 'onUsageLimits' | 'sessionUsage' | 'sessionPorts' | 'killPort'>

const NOW = Date.UTC(2026, 9, 22, 12)
const HOUR = 3_600_000
const PROJECTS = ['~/projects/treeix', '~/projects/betfeel/api']

/** Two weeks of rows, the same numbers every load */
function rows(): UsageRow[] {
  const out: UsageRow[] = []
  for (let d = 0; d < 14; d++) {
    const day = new Date(NOW - d * 24 * HOUR).toISOString().slice(0, 10)
    PROJECTS.forEach((project, p) => {
      const base = 40_000 + ((d * 7919 + p * 104_729) % 90_000)
      out.push({ day, agent: 'claude', model: 'claude-opus-4-5', project, session: `c-${d}-${p}`, input: base, output: base / 8, cacheRead: base * 12, cacheWrite: base * 2 })
      if (d % 3 === 0) out.push({ day, agent: 'codex', model: 'gpt-5-codex', project, session: `x-${d}-${p}`, input: base / 2, output: base / 10, cacheRead: base * 4, cacheWrite: 0 })
    })
  }
  return out
}

const USAGE: AgentUsage = {
  rows: rows(),
  prices: { 'claude-opus-4-5': [5, 25, 0.5, 6.25], 'gpt-5-codex': [1.25, 10, 0.125, 0] },
  titles: { 'c-0-0': 'Redo terminal: blocks + splits', 'c-0-1': 'Fix odds rounding' },
}

const LIMITS: UsageLimits = {
  claude: { fiveHour: { usedPercent: 42, resetsAt: NOW + 2 * HOUR }, weekly: { usedPercent: 67, resetsAt: NOW + 3 * 24 * HOUR }, updatedAt: NOW },
  codex: { fiveHour: { usedPercent: 8, resetsAt: NOW + 4 * HOUR }, weekly: { usedPercent: 21, resetsAt: NOW + 5 * 24 * HOUR }, updatedAt: NOW },
}

export function agentsMock(): AgentsApi {
  const seeded = new URLSearchParams(location.search).get('seed') !== 'empty'
  let ports = !seeded ? [] : [
    { session: 's1', port: 5173, pid: 41_201, command: 'node', cwd: '/Users/me/projects/treeix' },
    { session: 's1', port: 24_678, pid: 41_201, command: 'node', cwd: '/Users/me/projects/treeix' },
    { session: 's3', port: 6499, pid: 41_377, command: 'bun', cwd: '/Users/me/projects/treeix/packages/ui' },
  ]
  return {
    agentUsage: async () => USAGE,
    usageLimits: async () => LIMITS,
    onUsageLimits: () => () => {},
    sessionUsage: async (session) => (session === 's4' || session === 's6' || session === 's7' ? { input: 182_000, output: 24_300, cached: 1_840_000, costUsd: 4.12 } : session === 's5' ? { input: 96_000, output: 12_000, cached: 410_000, costUsd: null } : null),
    sessionPorts: async () => ports,
    async killPort(port, pid) {
      if (!ports.some((p) => p.port === port && p.pid === pid)) throw new Error(`nothing listens on ${port}`)
      ports = ports.filter((p) => p.pid !== pid)
    },
  }
}
