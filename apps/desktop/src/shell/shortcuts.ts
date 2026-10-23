import type { Direction } from './state'

/** Everything a key, the app menu (its item ids) or the palette can trigger */
export type CommandId =
  | 'new-shell'
  | 'new-claude'
  | 'new-codex'
  | 'open-folder'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'next-tab'
  | 'prev-tab'
  | 'palette'
  | 'toggle-sidebar'
  | 'settings'
  | 'toggle-tabs'
  | 'toggle-ui'
  | 'toggle-theme'
  | 'module-graph'
  | 'record'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | `tab-${number}`
  | `focus-${Direction}`

const MENU_IDS = new Set<string>(['new-shell', 'new-claude', 'new-codex', 'open-folder', 'split-right', 'split-down', 'close-pane', 'next-tab', 'prev-tab', 'palette', 'toggle-sidebar', 'settings', 'toggle-tabs', 'toggle-ui', 'toggle-theme', 'module-graph', 'record', 'zoom-in', 'zoom-out', 'zoom-reset'])

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>

/** What the native menu (src-tauri/src/menu.rs, macOS only) binds when settings.keys leaves the item alone */
const MENU_KEYS: Record<string, string> = { settings: 'Super+Comma', 'toggle-sidebar': 'Super+Backslash', palette: 'Shift+Super+KeyP' }

/** Whether the native menu owns this chord, rebound ones included ('' unbinds): inside Tauri it fires them, keydown must not too */
export function menuChord(e: Keys, keys: Partial<Record<string, string>>, mac = IS_MAC): boolean {
  const accel = mac && accelerator(e)
  return !!accel && Object.entries(MENU_KEYS).some(([id, chord]) => (keys[id] ?? chord) === accel)
}

export const isCommandId = (id: string): id is CommandId => MENU_IDS.has(id) || /^tab-[1-9]$/.test(id) || /^focus-(left|right|up|down)$/.test(id)

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/** Ctrl+Tab and Ctrl+Shift+Tab cycle tabs on every platform; the terminal hands them up (panes/terminal/keys.ts) */
const ctrlTab = (e: Keys): CommandId | null => (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Tab' ? (e.shiftKey ? 'prev-tab' : 'next-tab') : null)

export function shortcut(e: Keys, mac = IS_MAC): CommandId | null {
  return ctrlTab(e) ?? (mac ? macShortcut(e) : linuxShortcut(e))
}

/** Browser zoom keys; Shift+= is + */
const ZOOM: Record<string, CommandId> = { Equal: 'zoom-in', Minus: 'zoom-out', Digit0: 'zoom-reset' }

function macShortcut(e: Keys): CommandId | null {
  if (!e.metaKey || e.ctrlKey) return null
  if (e.altKey) return ARROWS[e.key] && !e.shiftKey ? `focus-${ARROWS[e.key]}` : null
  if (ZOOM[e.code]) return ZOOM[e.code]
  const key = e.key.toLowerCase()
  if (e.shiftKey) {
    if (e.code === 'BracketLeft') return 'prev-tab'
    if (e.code === 'BracketRight') return 'next-tab'
    if (key === 'd') return 'split-down'
    if (key === 'p') return 'palette'
    if (key === 'g') return 'module-graph'
    if (key === 'r') return 'record'
    return null
  }
  if (/^[1-9]$/.test(e.key)) return `tab-${Number(e.key)}`
  if (e.code === 'Backslash') return 'toggle-sidebar'
  const plain: Record<string, CommandId> = { t: 'new-shell', o: 'open-folder', d: 'split-right', w: 'close-pane', k: 'palette', ',': 'settings' }
  return plain[key] ?? null
}

/** Ctrl+Shift+G is Changes (panels/Panels.tsx), so the module graph takes M */
const LINUX_CTRL_SHIFT: Record<string, CommandId> = { KeyT: 'new-shell', KeyO: 'open-folder', KeyW: 'close-pane', KeyP: 'palette', KeyD: 'split-right', KeyE: 'split-down', KeyB: 'toggle-sidebar', KeyM: 'module-graph', KeyR: 'record', ...ZOOM }

/** Like GNOME Terminal and Konsole: app chords are Ctrl+Shift, so plain Ctrl+<key> stays the shell's */
function linuxShortcut(e: Keys): CommandId | null {
  if (e.metaKey) return null
  if (e.altKey) return !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code) ? `tab-${Number(e.code.slice(5))}` : null
  if (!e.ctrlKey) return null
  if (e.shiftKey) return LINUX_CTRL_SHIFT[e.code] ?? null
  if (e.code === 'PageUp') return 'prev-tab'
  if (e.code === 'PageDown') return 'next-tab'
  return e.key === ',' ? 'settings' : null
}

const MAC_HINTS: Partial<Record<CommandId, string>> = {
  'new-shell': '⌘T',
  'open-folder': '⌘O',
  'split-right': '⌘D',
  'split-down': '⇧⌘D',
  'close-pane': '⌘W',
  palette: '⌘K',
  'toggle-sidebar': '⌘\\',
  settings: '⌘,',
  'module-graph': '⇧⌘G',
  record: '⇧⌘R',
  'zoom-in': '⌘=',
  'zoom-out': '⌘-',
  'zoom-reset': '⌘0',
}
const LINUX_HINTS: Partial<Record<CommandId, string>> = {
  'new-shell': 'Ctrl+Shift+T',
  'open-folder': 'Ctrl+Shift+O',
  'split-right': 'Ctrl+Shift+D',
  'split-down': 'Ctrl+Shift+E',
  'close-pane': 'Ctrl+Shift+W',
  palette: 'Ctrl+Shift+P',
  'toggle-sidebar': 'Ctrl+Shift+B',
  settings: 'Ctrl+,',
  'module-graph': 'Ctrl+Shift+M',
  record: 'Ctrl+Shift+R',
  'zoom-in': 'Ctrl+Shift+=',
  'zoom-out': 'Ctrl+Shift+-',
  'zoom-reset': 'Ctrl+Shift+0',
}

/** The chord shown next to a command in buttons, tooltips and the palette */
export const keyHint = (id: CommandId, mac = IS_MAC): string | undefined => (mac ? MAC_HINTS : LINUX_HINTS)[id]

/** `label (chord)` for a tooltip */
export const withHint = (label: string, id: CommandId) => (keyHint(id) ? `${label} (${keyHint(id)})` : label)

export const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

/**
 * A global-shortcut accelerator (global-hotkey) from a recorded chord, e.g. `Control+Backquote`. Null until a
 * non-modifier key is down with at least one modifier, so a bare letter can't steal typing everywhere. F-keys and §
 * (IntlBackslash, rarely typed) work alone
 */
export function accelerator(e: Keys): string | null {
  if (MODIFIER_KEYS.has(e.key) || !e.code) return null
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter((m): m is string => !!m)
  if (!mods.length && !/^(F\d+|IntlBackslash)$/.test(e.code)) return null
  return [...mods, e.code].join('+')
}

const MOD_LABEL: Record<string, [mac: string, other: string]> = { Control: ['⌃', 'Ctrl+'], Alt: ['⌥', 'Alt+'], Shift: ['⇧', 'Shift+'], Super: ['⌘', 'Super+'] }
const CODE_LABEL: Record<string, string> = { Backquote: '`', Space: 'Space', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Escape: 'Esc', Enter: '↵' }

/** How an accelerator from `accelerator` reads: ⌃` on macOS, Ctrl+` elsewhere */
export function acceleratorLabel(accel: string, mac = IS_MAC): string {
  const parts = accel.split('+')
  const code = parts.pop() ?? ''
  // IntlBackslash is § top left on a Mac ISO keyboard, < by left Shift elsewhere
  const key = code === 'IntlBackslash' ? (mac ? '§' : '<') : (CODE_LABEL[code] ?? code.replace(/^(Key|Digit|Numpad)/, ''))
  return parts.map((m) => MOD_LABEL[m]?.[mac ? 0 : 1] ?? `${m}+`).join('') + key
}

/** A dialog is up or the settings recorder is taking a chord */
export const shortcutsPaused = () => document.querySelector('[aria-modal], .krec.on') !== null
