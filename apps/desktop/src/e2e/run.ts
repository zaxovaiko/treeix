// The DOM-free half of the in-app e2e (TREEIX_AUTORUN=e2e): runs named steps and reports, unit-tested in run.test.ts

export interface E2eReport {
  passed: { name: string; ms: number }[]
  failed: { name: string; error: string }[]
}

export type Step = [name: string, run: () => Promise<void>]

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs every step in order; a failed step is reported and the rest still run */
export async function runSteps(steps: Step[], now: () => number = () => performance.now()): Promise<E2eReport> {
  const report: E2eReport = { passed: [], failed: [] }
  for (const [name, run] of steps) {
    const started = now()
    try {
      await run()
      report.passed.push({ name, ms: Math.round(now() - started) })
    } catch (error) {
      report.failed.push({ name, error: errorText(error) })
    }
  }
  return report
}

/** Polls `check` until it returns something other than null, undefined or false, or throws naming `what` after `timeoutMs` */
export async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 5000, everyMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    try {
      const value = await check()
      if (value !== null && value !== undefined && value !== false) return value
      last = null
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${errorText(last)}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

const meaningful = (lines: string[]): string[] => lines.map((line) => line.trimEnd()).filter(Boolean)

/** Null when two renders of a terminal hold the same text (blank lines and trailing spaces aside), else where they part */
export function scrollbackDiff(before: string[], after: string[]): string | null {
  const a = meaningful(before)
  const b = meaningful(after)
  const at = a.findIndex((line, i) => line !== b[i])
  if (at === -1 && a.length === b.length) return null
  const line = at === -1 ? a.length : at
  return `line ${line} of ${a.length}/${b.length}: ${JSON.stringify(a[line] ?? null)} became ${JSON.stringify(b[line] ?? null)}`
}
