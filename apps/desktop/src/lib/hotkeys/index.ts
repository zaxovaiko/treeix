import { terminalKey } from '../../panes/terminal/keys'
import { accelerator, acceleratorLabel, IS_MAC, shortcut, type CommandId } from '../../shell/shortcuts'

// App shortcuts the user can rebind (`settings.keys`: action id to accelerator, '' unbinds), and the chords they would collide with

/** `settings.keys` */
export type Keymap = Partial<Record<string, string>>

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>

/** In the order Settings lists them, under their group's title */
export const ACTIONS = [
  ['new-shell', 'New shell', 'Sessions'],
  ['new-claude', 'New Claude', 'Sessions'],
  ['new-codex', 'New Codex', 'Sessions'],
  ['open-folder', 'Open folder', 'Sessions'],
  ['record', 'Record a meeting', 'Sessions'],
  ['close-pane', 'Close pane', 'Tabs and panes'],
  ['reopen-tab', 'Reopen closed tab', 'Tabs and panes'],
  ['split-right', 'Split right', 'Tabs and panes'],
  ['split-down', 'Split down', 'Tabs and panes'],
  ['next-tab', 'Next tab', 'Tabs and panes'],
  ['prev-tab', 'Previous tab', 'Tabs and panes'],
  ['palette', 'Command palette', 'Navigation'],
  ['toggle-sidebar', 'Toggle sidebar', 'Navigation'],
  ['module-graph', 'Module graph', 'Navigation'],
  ['settings', 'Settings', 'Navigation'],
  ['toggle-tabs', 'Tabs on top or on the side', 'Appearance'],
  ['toggle-theme', 'Light or dark', 'Appearance'],
  ['zoom-in', 'Zoom in', 'Appearance'],
  ['zoom-out', 'Zoom out', 'Appearance'],
  ['zoom-reset', 'Actual size', 'Appearance'],
] as const satisfies readonly (readonly [CommandId, string, string])[]

export type ActionId = (typeof ACTIONS)[number][0]

const isAction = (id: string): id is ActionId => ACTIONS.some(([action]) => action === id)

/** Prototype chords shortcuts.ts doesn't bind; on Linux Ctrl+Shift+C belongs to the terminal, so none there */
const EXTRA_DEFAULTS: Partial<Record<ActionId, string>> = { 'new-claude': 'Shift+Super+KeyC', 'new-codex': 'Shift+Super+KeyX' }

const CODES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  'Comma', 'Equal', 'Minus', 'Backslash', 'BracketLeft', 'BracketRight', 'Tab', 'PageUp', 'PageDown',
]
const CODE_KEYS: Record<string, string> = { Comma: ',', Equal: '=', Minus: '-', Backslash: '\\', BracketLeft: '[', BracketRight: ']' }
/** Fewest modifiers first, so the first hit is the chord the hints show */
const MODS = ['', 'Control+', 'Super+', 'Control+Shift+', 'Shift+Super+', 'Alt+Super+']

/** A keydown for an accelerator, close enough for `shortcut`, which reads `code` and, for letters and `,`, `key` */
export function chordOf(accel: string): Keys {
  const parts = accel.split('+')
  const code = parts.pop() ?? ''
  const key = CODE_KEYS[code] ?? code.replace(/^(Key|Digit)/, '').toLowerCase()
  return { code, key: key.length === 1 ? key : code, ctrlKey: parts.includes('Control'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: parts.includes('Super') }
}

const cache = new Map<boolean, Partial<Record<ActionId, string>>>()

/** Built-in chords as accelerators, read off `shortcut` itself so the two can't drift */
export function defaultKeys(mac = IS_MAC): Partial<Record<ActionId, string>> {
  const known = cache.get(mac)
  if (known) return known
  const out: Partial<Record<ActionId, string>> = mac ? { ...EXTRA_DEFAULTS } : {}
  for (const mods of MODS) {
    for (const code of CODES) {
      const accel = mods + code
      const id = shortcut(chordOf(accel), mac)
      if (id && isAction(id) && !out[id]) out[id] = accel
    }
  }
  cache.set(mac, out)
  return out
}

/** The chord an action answers to now: the override, else the default; null when unbound */
export function keyFor(id: ActionId, keys: Keymap, mac = IS_MAC): string | null {
  const override = keys[id]
  return (override === undefined ? defaultKeys(mac)[id] : override) || null
}

/** The command for a keydown with the overrides applied: a rebound action fires on its new chord only, an unbound one never */
export function resolveShortcut(e: Keys, keys: Keymap, mac = IS_MAC): CommandId | null {
  const accel = accelerator(e)
  if (accel) {
    const hit = ACTIONS.find(([id]) => keyFor(id, keys, mac) === accel)
    if (hit) return hit[0]
  }
  const id = shortcut(e, mac)
  if (!id) return null
  if (!isAction(id)) return id
  return keys[id] === undefined ? id : null
}

/** Chords other code takes before or beside the app shortcuts (dialogs/index.tsx, panels/Panels.tsx) */
const RESERVED = (mac: boolean): [accel: string, what: string][] =>
  mac
    ? [['Shift+Super+KeyN', 'Open worktree'], ['Shift+Super+KeyF', 'Find in files'], ['Shift+Super+KeyE', 'Explorer'], ['Control+Shift+KeyG', 'Changes']]
    : [['Control+Shift+KeyN', 'Open worktree'], ['Control+Shift+KeyF', 'Find in files'], ['Control+Shift+KeyG', 'Changes']]

/** Why `accel` is a bad pick for `id`, or null when it is free */
export function conflict(id: ActionId | 'hotkey', accel: string | null, keys: Keymap, mac = IS_MAC): string | null {
  if (!accel) return null
  const same = ACTIONS.find(([other]) => other !== id && keyFor(other, keys, mac) === accel)
  if (same) return `Same keys as ${same[1]}`
  const reserved = RESERVED(mac).find(([chord]) => chord === accel)
  if (reserved) return `Same keys as ${reserved[1]}`
  // The hotkey window's chord is global: the focused app never sees it, so the terminal can't either
  if (id === 'hotkey') return null
  const action = terminalKey(chordOf(accel), mac)
  if (action.type !== 'app') return `${acceleratorLabel(accel, mac)} goes to the terminal`
  return null
}
