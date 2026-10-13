import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'

/** A helper that ran this long before dying starts again right away; quicker deaths back off up to MAX_BACKOFF_MS */
const HEALTHY_MS = 60_000
const MAX_BACKOFF_MS = 30_000

/** The Swift helpers run speech models on the Neural Engine through FluidAudio, which needs macOS 14 (Darwin 23) */
export const nativeHelpersSupported = process.platform === 'darwin' && process.arch === 'arm64' && Number(release().split('.')[0]) >= 23

/** A binary built from `apps/desktop/native/voice`, unpacked next to the asar in a packaged app */
export const nativeBinary = (name: string): string => join(app.getAppPath(), 'native', 'voice', 'bin', name).replace('app.asar', 'app.asar.unpacked')

/** Speech models both helpers load, so dictation and meetings share one download */
export const speechModelsPath = (): string => join(app.getPath('userData'), 'models')

export type NativeHelper = { send: (message: Record<string, unknown>) => void; stop: () => void }

/**
 * Runs a helper that talks JSON lines over stdio and starts it again when it dies; `down` gets why.
 * Returns null when the binary isn't built.
 */
export function superviseHelper(binary: string, name: string, events: { line: (line: string) => void; down: (reason: string) => void }): NativeHelper | null {
  if (!existsSync(binary)) return null
  let child: ReturnType<typeof spawn> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let stopped = false

  const start = (): void => {
    const startedAt = Date.now()
    const current = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = current
    // Writing to a helper that just died fails asynchronously; the exit handler restarts it
    current.stdin?.on('error', () => undefined)
    current.stderr?.resume()
    if (current.stdout) createInterface({ input: current.stdout }).on('line', events.line)
    let ended = false
    const exited = (reason: string): void => {
      if (ended) return
      ended = true
      child = null
      if (stopped) return
      failures = Date.now() - startedAt > HEALTHY_MS ? 0 : failures + 1
      events.down(reason)
      restartTimer = setTimeout(start, Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures))
    }
    current.on('error', (error) => exited(`The ${name} helper couldn't start: ${error.message}`))
    current.on('exit', (code, signal) => exited(`The ${name} helper stopped (${signal ?? `exit ${code}`}), restarting`))
  }

  start()
  return {
    send: (message) => void child?.stdin?.write(`${JSON.stringify(message)}\n`),
    stop: () => {
      stopped = true
      clearTimeout(restartTimer)
      child?.kill()
    }
  }
}
