// `bun bench/compare.ts <baseline.json> <result.json>`: compares two ptyd-bench reports (crates/ptyd/src/bin/ptyd-bench.rs)
// and exits 1 when any metric regressed by more than 10%. CI runs it against bench/baseline/<runner>.json when that exists
import { readFileSync } from 'node:fs'

export const TOLERANCE = 0.1

/** Path into the report, and whether more is better */
const METRICS: [path: string, higherIsBetter: boolean][] = [
  ['attached_mb_s', true],
  ['detached_mb_s', true],
  ['echo_ms.p95', false],
  ['daemon_rss_mb_20_idle_shells', false],
]

export interface Row {
  metric: string
  baseline: number
  current: number
  /** Positive is worse, as a fraction of the baseline */
  regression: number
}

function read(report: unknown, path: string): number | null {
  let value = report
  for (const key of path.split('.')) value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Metrics missing from either report are left out */
export function compare(baseline: unknown, current: unknown): Row[] {
  return METRICS.flatMap(([metric, higherIsBetter]) => {
    const before = read(baseline, metric)
    const after = read(current, metric)
    if (before === null || after === null || before === 0) return []
    const change = (after - before) / before
    return [{ metric, baseline: before, current: after, regression: higherIsBetter ? -change : change }]
  })
}

if (import.meta.main) {
  const [baselinePath, currentPath] = process.argv.slice(2)
  if (!baselinePath || !currentPath) {
    console.error('usage: bun bench/compare.ts <baseline.json> <result.json>')
    process.exit(2)
  }
  const load = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
  const rows = compare(load(baselinePath), load(currentPath))
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
  for (const row of rows) {
    const flag = row.regression > TOLERANCE ? 'REGRESSED' : 'ok'
    console.log(`${row.metric.padEnd(30)} ${String(+row.baseline.toFixed(3)).padStart(10)} -> ${String(+row.current.toFixed(3)).padStart(10)}  ${pct(-row.regression).padStart(7)}  ${flag}`)
  }
  const regressed = rows.filter((row) => row.regression > TOLERANCE)
  if (!rows.length) console.error('no metric in common')
  process.exit(regressed.length || !rows.length ? 1 : 0)
}
