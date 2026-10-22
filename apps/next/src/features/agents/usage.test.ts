import { describe, expect, test } from 'bun:test'
import type { AgentUsage, UsageRow } from '../../ipc/api'
import { level, pillParts, rowCost, summarize, untilLabel } from './usage'

const row = (day: string, model: string, project: string, input: number): UsageRow => ({ day, agent: 'claude', model, project, session: 's', input, output: 0, cacheRead: 0, cacheWrite: 0 })

describe('untilLabel', () => {
  const now = 1_000_000_000
  test('minutes, hours, days', () => {
    expect(untilLabel(null, now)).toBeNull()
    expect(untilLabel(now - 5000, now)).toBe('0m')
    expect(untilLabel(now + 45 * 60_000, now)).toBe('45m')
    expect(untilLabel(now + 72 * 60_000, now)).toBe('1h 12m')
    expect(untilLabel(now + 2 * 3_600_000, now)).toBe('2h')
    expect(untilLabel(now + 76 * 3_600_000, now)).toBe('3d 4h')
  })
})

test('level', () => {
  expect([level(60), level(61), level(90)]).toEqual(['', 'warn', 'err'])
})

describe('pillParts', () => {
  const w = (usedPercent: number) => ({ usedPercent, resetsAt: null })
  test('chosen window first, Claude before Codex', () => {
    const limits = { claude: { fiveHour: w(64.4), weekly: w(38), updatedAt: null }, codex: { fiveHour: w(1), weekly: w(2), updatedAt: null } }
    expect(pillParts(limits, 'fiveHour')).toEqual({ agent: 'claude', main: { label: '5h', percent: 64 }, other: { label: 'wk', percent: 38 } })
    expect(pillParts(limits, 'weekly')?.main).toEqual({ label: 'wk', percent: 38 })
  })
  test('falls back to Codex and to the window that is known', () => {
    expect(pillParts({ claude: null, codex: { fiveHour: w(8), weekly: null, updatedAt: null } }, 'weekly')).toEqual({ agent: 'codex', main: { label: '5h', percent: 8 }, other: null })
    expect(pillParts({ claude: null, codex: null }, 'weekly')).toBeNull()
    expect(pillParts(null, 'weekly')).toBeNull()
  })
})

test('rowCost is per million tokens', () => {
  const r: UsageRow = { ...row('2026-10-22', 'm', 'p', 1_000_000), output: 2_000_000, cacheRead: 10_000_000, cacheWrite: 0 }
  expect(rowCost(r, { m: [5, 25, 0.5, 6.25] })).toBe(5 + 50 + 5)
  expect(rowCost(r, {})).toBe(0)
})

test('summarize keeps the last days and groups them', () => {
  const usage: AgentUsage = {
    rows: [row('2026-10-22', 'a', 'x', 3_000_000), row('2026-10-20', 'b', 'y', 1_000_000), row('2026-10-16', 'b', 'y', 1_000_000), row('2026-10-15', 'a', 'x', 9)],
    prices: { a: [1, 0, 0, 0] },
    titles: {},
  }
  const s = summarize(usage, 7, new Date(2026, 9, 22, 15))
  expect(s.days.map((d) => d.name)).toEqual(['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'])
  expect(s.days.map((d) => d.tokens)).toEqual([1_000_000, 0, 0, 0, 1_000_000, 0, 3_000_000])
  expect(s.tokens).toBe(5_000_000)
  expect(s.cost).toBe(3)
  expect(s.models.map((m) => m.name)).toEqual(['a', 'b'])
  expect(s.projects).toEqual([{ name: 'x', tokens: 3_000_000, cost: 3 }, { name: 'y', tokens: 2_000_000, cost: 0 }])
})
