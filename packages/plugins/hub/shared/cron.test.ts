import { expect, test } from 'bun:test'
import { cronMatches, isCron } from './cron'

// 2026-10-05 is a Monday
const at = (day: number, hour: number, minute: number): Date => new Date(2026, 9, day, hour, minute)

test('matches minutes, hours and weekdays', () => {
  expect(cronMatches('0 9 * * 1', at(5, 9, 0))).toBe(true)
  expect(cronMatches('0 9 * * 1', at(5, 9, 1))).toBe(false)
  expect(cronMatches('0 9 * * 1', at(6, 9, 0))).toBe(false)
  expect(cronMatches('0 9 * * 1-5', at(9, 9, 0))).toBe(true)
  expect(cronMatches('0 9 * * 1-5', at(10, 9, 0))).toBe(false)
  expect(cronMatches('0 9 * * 7', at(11, 9, 0))).toBe(true)
})

test('steps, lists and ranges', () => {
  expect(cronMatches('*/15 * * * *', at(5, 3, 45))).toBe(true)
  expect(cronMatches('*/15 * * * *', at(5, 3, 46))).toBe(false)
  expect(cronMatches('5/20 * * * *', at(5, 3, 25))).toBe(true)
  expect(cronMatches('0 8,18 * * *', at(5, 18, 0))).toBe(true)
  expect(cronMatches('0 9-17/4 * * *', at(5, 13, 0))).toBe(true)
  expect(cronMatches('0 9-17/4 * * *', at(5, 15, 0))).toBe(false)
})

test('either day field is enough when both are set', () => {
  expect(cronMatches('0 9 1 * 1', at(5, 9, 0))).toBe(true)
  expect(cronMatches('0 9 1 * 1', at(1, 9, 0))).toBe(true)
  expect(cronMatches('0 9 1 * 1', at(6, 9, 0))).toBe(false)
})

test('rejects malformed lines', () => {
  expect(isCron('0 9 * * 1')).toBe(true)
  for (const bad of ['', '0 9 * *', '60 * * * *', '* 24 * * *', '0 0 0 * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *']) expect(isCron(bad)).toBe(false)
})
