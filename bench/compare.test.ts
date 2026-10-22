import { expect, test } from 'bun:test'
import { compare, TOLERANCE } from './compare'

const report = (attached: number, echoP95: number, rss: number) => ({ attached_mb_s: attached, detached_mb_s: 100, echo_ms: { p50: 0.2, p95: echoP95, p99: 0.4 }, daemon_rss_mb_20_idle_shells: rss })

test('slower throughput and higher latency or memory count as regressions', () => {
  const rows = compare(report(100, 1, 10), report(80, 1.2, 10.5))
  expect(rows.map((r) => [r.metric, +r.regression.toFixed(3)])).toEqual([
    ['attached_mb_s', 0.2],
    ['detached_mb_s', 0],
    ['echo_ms.p95', 0.2],
    ['daemon_rss_mb_20_idle_shells', 0.05],
  ])
  expect(rows.filter((r) => r.regression > TOLERANCE).map((r) => r.metric)).toEqual(['attached_mb_s', 'echo_ms.p95'])
})

test('improvements are negative regressions', () => {
  const [attached] = compare(report(100, 1, 10), report(150, 1, 10))
  expect(attached.regression).toBe(-0.5)
})

test('metrics missing or skipped on either side are left out', () => {
  expect(compare({ skipped: 'no ptyd' }, report(1, 1, 1))).toEqual([])
  expect(compare({ attached_mb_s: 10 }, { attached_mb_s: 'n/a' })).toEqual([])
})
