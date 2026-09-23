import { app, BrowserWindow, globalShortcut, type Rectangle, screen } from 'electron'
import { carbonModifiers, isShortcut, macKeyCode, toAccelerator } from '../shared/shortcut'
import type { HotkeyOptions } from '../shared/types'
import { nativeHotkeys, setDockHidden, setSquareCorners } from './macWindow'

let registered: string | null = null
let hideOnBlur = true
/** Hotkey-only mode: the window never turns back into a normal one, so showing it again changes nothing on screen */
let only = false
/** True while the window is shown as the drop-down hotkey window */
let summoned = false
let normalBounds: Rectangle | null = null
let summonedBounds: Rectangle | null = null
const watched = new WeakSet<BrowserWindow>()

/** Borderless while summoned: no traffic lights, shadow or frame edge, no dragging */
function setChrome(window: BrowserWindow, visible: boolean): void {
  setSquareCorners(window, !visible)
  if (process.platform === 'darwin') {
    window.setWindowButtonVisibility(visible)
    // Restoring the title bar resets the custom traffic light inset
    if (visible) window.setWindowButtonPosition({ x: 14, y: 10 })
  }
  window.setHasShadow(visible)
  window.setMovable(visible)
  window.setResizable(visible)
  window.webContents.send('window-chromeless', !visible)
}

/** Whether the window is shown borderless as the hotkey window right now */
export const isSummoned = (): boolean => summoned

function summon(window: BrowserWindow): void {
  if (!summoned) normalBounds = window.getBounds()
  summoned = true
  const { bounds, workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  // ponytail: skipTransformProcessType keeps the Dock icon stable but may not overlay other apps' full-screen spaces
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  window.setAlwaysOnTop(true, 'floating')
  if (window.isMinimized()) window.restore()
  // Like iTerm2: the Dock auto-hides while this window is in front, so only the macOS menu bar stays visible
  setDockHidden(true)
  const menuBar = workArea.y - bounds.y
  const fullBounds = { x: bounds.x, y: workArea.y, width: bounds.width, height: bounds.height - menuBar }
  summonedBounds = fullBounds
  const current = window.getBounds()
  if (current.x !== fullBounds.x || current.y !== fullBounds.y || current.width !== fullBounds.width || current.height !== fullBounds.height) window.setBounds(fullBounds)
  // The Dock hides on the next run loop turn and macOS clamps windows to the visible frame until then
  setTimeout(() => summoned && window.setBounds(fullBounds), 100)
  window.show()
  // Showing a hidden window restores its standard buttons, so strip the chrome afterwards
  setChrome(window, false)
  window.focus()
  app.focus({ steal: true })
}

/** Back to a normal window, in place */
function restore(window: BrowserWindow): void {
  summoned = false
  setDockHidden(false)
  setChrome(window, true)
  window.setAlwaysOnTop(false)
  window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
  if (normalBounds) window.setBounds(normalBounds)
}

/** Focus went to a window on another display, so the hotkey window is not in its way and stays up */
const clickedOtherDisplay = (window: BrowserWindow): boolean =>
  screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id !== screen.getDisplayMatching(window.getBounds()).id

function dismiss(window: BrowserWindow): void {
  // Hiding the app hands focus back to whatever was in front before
  if (process.platform === 'darwin') app.hide()
  else window.hide()
  if (!only) restore(window)
}

/** `focused` is whether the window had focus when the shortcut was pressed */
export function toggleHotkeyWindow(window: BrowserWindow, focused = window.isFocused()): void {
  if (summoned && window.isVisible() && focused) dismiss(window)
  else summon(window)
}

/** Registers the global shortcut; returns an error message when it cannot be used */
export function configureHotkey(window: BrowserWindow, options: HotkeyOptions): string | null {
  hideOnBlur = options.hideOnBlur
  if (options.only !== only) {
    only = options.only
    // Hotkey-only leaves ⌘Tab and the Dock, so the shortcut is the one way in; otherwise it is a regular app again
    if (process.platform === 'darwin') app.setActivationPolicy(only ? 'accessory' : 'regular')
    if (only && !summoned) summon(window)
    else if (!only && summoned) restore(window)
    if (!only) {
      window.show()
      window.focus()
    }
  }
  if (!watched.has(window)) {
    watched.add(window)
    window.on('blur', () => {
      if (summoned && hideOnBlur && !window.webContents.isDevToolsFocused() && !clickedOtherDisplay(window)) dismiss(window)
    })
    // Activation finishes asynchronously; options set before it can be ignored until the next activation, leaving the Dock up
    app.on('did-become-active', () => {
      if (!summoned) return
      setDockHidden(false)
      setDockHidden(true)
      setTimeout(() => summoned && summonedBounds && window.setBounds(summonedBounds), 100)
    })
  }
  const shortcut = options.shortcut && isShortcut(options.shortcut) ? options.shortcut : null
  const key = shortcut ? JSON.stringify(shortcut) : null
  if (registered === key) return null
  unregister()
  if (!shortcut || !key) {
    // Turning the feature off while the window is summoned gives the normal window back
    if (summoned && !only) restore(window)
    return null
  }

  const keyCode = macKeyCode(shortcut)
  if (nativeHotkeys && keyCode !== null) {
    // The native handler already activated the app, so focus must come from before the key press
    if (!nativeHotkeys.register(keyCode, carbonModifiers(shortcut), (wasActive) => toggleHotkeyWindow(window, wasActive && window.isFocused()))) {
      return 'This shortcut is already taken by another app or macOS'
    }
  } else {
    const accelerator = toAccelerator(shortcut)
    if (!accelerator) return 'This key can only be used with the native macOS helper (bun run build:native)'
    if (!globalShortcut.register(accelerator, () => toggleHotkeyWindow(window))) return 'This shortcut is already taken by another app or macOS'
  }
  registered = key
  return null
}

function unregister(): void {
  nativeHotkeys?.unregister()
  globalShortcut.unregisterAll()
  registered = null
}

export const releaseHotkey = unregister
