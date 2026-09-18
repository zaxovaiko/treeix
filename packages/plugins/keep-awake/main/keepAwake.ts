import { execFile, execFileSync } from 'node:child_process'
import { powerSaveBlocker } from 'electron'

/** Whether Treeix itself turned lid-close sleep off, so it only ever restores what it changed */
let sleepDisabledByUs = false
let blockerId: number | null = null

const pmsetScript = (disable: boolean): string => `do shell script "pmset -a disablesleep ${disable ? 1 : 0}" with administrator privileges`

/**
 * While agents work: blocks idle sleep (no password) and, when lidClosed is set, turns off lid-close sleep
 * through the macOS administrator prompt. Resolves false when the prompt is cancelled or fails.
 */
export function setKeepAwake(active: boolean, lidClosed: boolean): Promise<boolean> {
  if (active && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  const wantDisabled = active && lidClosed
  if (process.platform !== 'darwin' || wantDisabled === sleepDisabledByUs) return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile('osascript', ['-e', pmsetScript(wantDisabled)], (error) => {
      if (!error) sleepDisabledByUs = wantDisabled
      resolve(!error)
    })
  })
}

/** On quit: put lid-close sleep back if Treeix turned it off; a Mac stuck awake in a bag is worse than one more prompt */
export function restoreSleep(): void {
  if (blockerId !== null) powerSaveBlocker.stop(blockerId)
  if (!sleepDisabledByUs) return
  try {
    execFileSync('osascript', ['-e', pmsetScript(false)])
    sleepDisabledByUs = false
  } catch {
    // Cancelled: sleep stays off until `sudo pmset -a disablesleep 0` or the next time Treeix restores it
  }
}
