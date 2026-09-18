import { expect, test } from 'bun:test'
import { newestLimits, parseClaudeLimits, parseCodexLimits, parseDesktopUsage, parseStatusLineLimits, toWindow } from './limits'

const now = 1_789_590_000_000

test('toWindow resets expired windows', () => {
  expect(toWindow(35.4, 1_789_598_400, now)).toEqual({ usedPercent: 35, resetsAt: 1_789_598_400_000 })
  expect(toWindow(80, 1_789_500_000, now)).toEqual({ usedPercent: 0, resetsAt: null })
  expect(toWindow(null, 1, now)).toBeNull()
})

test('parseClaudeLimits reads the LimitBar snapshot', () => {
  const limits = parseClaudeLimits(
    { capturedAt: 1_789_590_351.7, fiveHour: { resetsAt: 1_789_598_400, usedPercent: 35 }, weekly: { resetsAt: 1_789_758_000, usedPercent: 28.000000000000004 } },
    now
  )
  expect(limits?.fiveHour?.usedPercent).toBe(35)
  expect(limits?.weekly?.usedPercent).toBe(28)
  expect(limits?.updatedAt).toBe(1_789_590_351_700)
  expect(parseClaudeLimits('nope', now)).toBeNull()
})

test('parseCodexLimits takes the newest rate_limits event and matches windows by length', () => {
  const event = (used: number): string =>
    JSON.stringify({
      timestamp: '2026-09-16T19:40:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: used, window_minutes: 300, resets_at: 1_789_597_950 },
          secondary: { used_percent: 5, window_minutes: 10_080, resets_at: 1_789_922_495 }
        }
      }
    })
  const limits = parseCodexLimits([event(10), '{"type":"other"}', event(25), 'not json', ''], now)
  expect(limits?.fiveHour).toEqual({ usedPercent: 25, resetsAt: 1_789_597_950_000 })
  expect(limits?.weekly?.usedPercent).toBe(5)
  expect(parseCodexLimits(['{"type":"other"}'], now)).toBeNull()
})

test('parseStatusLineLimits reads Claude Code status line rate_limits', () => {
  const input = { model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 8.4, resets_at: 1_789_598_400 }, seven_day: { used_percentage: 33, resets_at: 1_789_758_000 } } }
  expect(parseStatusLineLimits(input, 1_789_589_000_000, now)).toEqual({
    fiveHour: { usedPercent: 8, resetsAt: 1_789_598_400_000 },
    weekly: { usedPercent: 33, resetsAt: 1_789_758_000_000 },
    updatedAt: 1_789_589_000_000
  })
  expect(parseStatusLineLimits({ model: {} }, 1, now)).toBeNull()
})

test('parseDesktopUsage takes the newest sample and newestLimits borrows reset times', () => {
  const desktop = parseDesktopUsage({ version: 2, samples: [{ t: 1, org: 'o', u: { fh: 3, sd: 30 } }, { t: 1_789_589_500_000, org: 'o', u: { fh: 10.2, sd: 33 } }] })
  expect(desktop).toEqual({ fiveHour: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent: 33, resetsAt: null }, updatedAt: 1_789_589_500_000 })
  expect(parseDesktopUsage({ samples: [] })).toBeNull()

  const older = { fiveHour: { usedPercent: 4, resetsAt: 1_789_598_400_000 }, weekly: { usedPercent: 32, resetsAt: 1_789_500_000_000 }, updatedAt: 1_789_580_000_000 }
  expect(newestLimits([older, desktop, null], now)).toEqual({
    fiveHour: { usedPercent: 10, resetsAt: 1_789_598_400_000 },
    // The older weekly reset already passed, so it isn't borrowed
    weekly: { usedPercent: 33, resetsAt: null },
    updatedAt: 1_789_589_500_000
  })
  expect(newestLimits([null], now)).toBeNull()
})
