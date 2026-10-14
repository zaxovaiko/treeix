import { IS_MAC } from './platform'

/** A recorded key combination; `code` is the physical key (KeyboardEvent.code), so layouts don't change it */
export type Shortcut = { code: string; meta: boolean; alt: boolean; ctrl: boolean; shift: boolean }

export function isShortcut(value: unknown): value is Shortcut {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && ['meta', 'alt', 'ctrl', 'shift'].every((key) => typeof candidate[key] === 'boolean')
}

const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'Fn'])
export const isModifierCode = (code: string): boolean => MODIFIER_CODES.has(code)

const NAMED_KEYS: Record<string, string> = {
  IntlBackslash: '§',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Escape: 'Esc',
  Enter: '↵',
  Tab: 'Tab',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|20)$/.test(code)) return code
  return NAMED_KEYS[code] ?? code
}

/** ⌘ on macOS. Elsewhere hand-written checks read ⌘ as Ctrl and ⌃ as the Super key, as `forPlatform` does for defaults */
export const primaryKey = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => (IS_MAC ? event.metaKey : event.ctrlKey)
export const secondaryKey = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => (IS_MAC ? event.ctrlKey : event.metaKey)

/** Default keys are written for macOS. Elsewhere Ctrl stands in for ⌘, and ⌃⌘ becomes Ctrl+Alt since the desktop owns Super */
export const forPlatform = (shortcut: Shortcut): Shortcut => (IS_MAC || !shortcut.meta ? shortcut : { ...shortcut, meta: false, ctrl: true, alt: shortcut.alt || shortcut.ctrl })

type KeyChord = Pick<KeyboardEvent, 'code' | 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'> & { target?: EventTarget | null }

/** Linux terminals keep plain Ctrl chords for the shell (^C, ^R, ^W); Ctrl+Shift stands in for them there, see terminals.ts */
const isShellChord = (event: KeyChord): boolean =>
  !IS_MAC &&
  event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.code !== 'Tab' &&
  typeof Element !== 'undefined' &&
  event.target instanceof Element &&
  event.target.closest('.xterm') !== null

export const matchesShortcut = (event: KeyChord, shortcut: Shortcut | null): boolean =>
  shortcut !== null &&
  !isShellChord(event) &&
  event.code === shortcut.code &&
  event.metaKey === shortcut.meta &&
  event.altKey === shortcut.alt &&
  event.ctrlKey === shortcut.ctrl &&
  event.shiftKey === shortcut.shift

/** "⌃⌥⇧⌘ K" in the macOS modifier order, "Ctrl+Alt+Shift+K" elsewhere */
export function shortcutLabel(shortcut: Shortcut): string {
  if (!IS_MAC) return [shortcut.ctrl && 'Ctrl', shortcut.meta && 'Super', shortcut.alt && 'Alt', shortcut.shift && 'Shift', keyName(shortcut.code)].filter(Boolean).join('+')
  const modifiers = `${shortcut.ctrl ? '⌃' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.meta ? '⌘' : ''}`
  return `${modifiers}${modifiers ? ' ' : ''}${keyName(shortcut.code)}`
}

const SPELLED_MODIFIERS = [
  ['⌘', 'Ctrl'],
  ['⌃', 'Super'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift']
] as const

/** Key glyphs in UI copy ("⇧⌘T", "⌘ [ ]", "⌘-click") spelled out off macOS ("Ctrl+Shift+T", "Ctrl+[ ]", "Ctrl-click") */
export function keysText(text: string): string {
  if (IS_MAC) return text
  // The space in "⌘ W" goes only when a lone key follows, so "with ⌘ work" keeps it
  return text.replace(/([⌘⌃⌥⇧]+)(?: (?=\S(?:$|[\s)])))?/g, (match: string, run: string, offset: number) => {
    const names = SPELLED_MODIFIERS.filter(([glyph]) => run.includes(glyph))
      .map(([, name]) => name)
      .join('+')
    const next = text[offset + match.length]
    return next && !/[\s)-]/.test(next) ? `${names}+` : names
  })
}

// macOS virtual key codes (Events.h kVK_*) for the physical keys
const MAC_KEY_CODES: Record<string, number> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  KeyO: 31,
  KeyU: 32,
  KeyI: 34,
  KeyP: 35,
  KeyL: 37,
  KeyJ: 38,
  KeyK: 40,
  KeyN: 45,
  KeyM: 46,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Digit9: 25,
  Digit7: 26,
  Digit8: 28,
  Digit0: 29,
  Equal: 24,
  Minus: 27,
  BracketRight: 30,
  BracketLeft: 33,
  Quote: 39,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  Period: 47,
  Backquote: 50,
  IntlBackslash: 10,
  Enter: 36,
  Tab: 48,
  Space: 49,
  Backspace: 51,
  Escape: 53,
  Delete: 117,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  F13: 105,
  F14: 107,
  F15: 113,
  F16: 106,
  F17: 64,
  F18: 79,
  F19: 80,
  F20: 90,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121
}

export const macKeyCode = (shortcut: Shortcut): number | null => MAC_KEY_CODES[shortcut.code] ?? null

/** Carbon modifier flags: cmdKey, shiftKey, optionKey, controlKey */
export const carbonModifiers = ({ meta, shift, alt, ctrl }: Shortcut): number => (meta ? 256 : 0) | (shift ? 512 : 0) | (alt ? 2048 : 0) | (ctrl ? 4096 : 0)

const ACCELERATOR_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/** Electron accelerator for platforms without the native hotkey; null for keys Electron cannot name, like § */
export function toAccelerator(shortcut: Shortcut): string | null {
  const { code } = shortcut
  const key = /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) ? keyName(code) : /^F([1-9]|1[0-9]|20)$/.test(code) ? code : ACCELERATOR_KEYS[code]
  if (!key) return null
  return [shortcut.ctrl && 'Control', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.meta && (IS_MAC ? 'Command' : 'Super'), key].filter(Boolean).join('+')
}
