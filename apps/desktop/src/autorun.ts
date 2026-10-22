// `TREEIX_AUTORUN=<name>` (src-tauri/src/lib.rs): runs one of these once the app has loaded, saves its report next to the daemon's data and quits with its exit code
import { api } from './ipc/api'
import { commands } from './ipc/bindings'

interface Outcome {
  report: unknown
  code: number
}

const SETTLE_MS = 2000
/** A runner stuck past this reports a failure instead of hanging its caller */
const TIMEOUT_MS = 10 * 60_000

const RUNNERS: Record<string, () => Promise<Outcome>> = {
  bench: async () => ({ report: await (await import('./panes/terminal/bench')).runBench(await api()), code: 0 }),
  e2e: async () => {
    const report = await (await import('./e2e')).runE2e(await api())
    return { report, code: report.failed.length ? 1 : 0 }
  },
}

export async function autorun() {
  const name = await commands.autorun()
  const runner = name ? RUNNERS[name] : undefined
  if (!runner) return
  // Fonts, the first attach and WebGL settle before anything is timed
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS))
  const outcome = await Promise.race([runner(), timeout]).catch((error: unknown): Outcome => ({ report: { error: String(error) }, code: 1 }))
  await commands.autorunDone(JSON.stringify(outcome.report, null, 2), outcome.code)
}
