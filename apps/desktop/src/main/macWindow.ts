import { app, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

type MacWindowAddon = {
  setDockHidden: (hidden: boolean) => void
  setSquareCorners: (handle: Buffer, square: boolean) => void
  /** The callback receives whether the app was frontmost before the key press activated it */
  registerHotkey: (keyCode: number, modifiers: number, callback: (wasActive: boolean) => void) => boolean
  unregisterHotkey: () => void
}

const isAddon = (value: unknown): value is MacWindowAddon =>
  typeof value === 'object' && value !== null && ['setDockHidden', 'setSquareCorners', 'registerHotkey', 'unregisterHotkey'].every((key) => key in value)

/** Compiled from native/mac-window; missing on other platforms or before `bun run build:native`, then these are no-ops */
function loadAddon(): MacWindowAddon | null {
  if (process.platform !== 'darwin') return null
  const path = join(app.getAppPath(), 'native', 'mac-window', 'build', 'Release', 'mac_window.node').replace('app.asar', 'app.asar.unpacked')
  try {
    const addon: unknown = createRequire(__filename)(path)
    return isAddon(addon) ? addon : null
  } catch {
    return null
  }
}

const addon = loadAddon()

/** Null when the native add-on is unavailable, so callers can fall back to Electron's globalShortcut */
export const nativeHotkeys = addon
  ? { register: addon.registerHotkey, unregister: addon.unregisterHotkey }
  : null

export const setDockHidden = (hidden: boolean): void => addon?.setDockHidden(hidden)

export const setSquareCorners = (window: BrowserWindow, square: boolean): void =>
  addon?.setSquareCorners(window.getNativeWindowHandle(), square)
