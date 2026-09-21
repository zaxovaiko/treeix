export type BrowserAction = 'focusAddress' | 'reload' | 'back' | 'forward' | 'newTab' | 'reopenTab' | 'closeTab' | 'devtools' | 'designMode'

export type KeyInput = { code: string; meta: boolean; shift: boolean; alt: boolean; control: boolean }

const ACTIONS: Record<string, BrowserAction> = {
  KeyL: 'focusAddress',
  KeyR: 'reload',
  BracketLeft: 'back',
  BracketRight: 'forward',
  KeyT: 'newTab',
  '⇧KeyT': 'reopenTab',
  KeyW: 'closeTab',
  '⌥KeyI': 'devtools',
  '⇧KeyC': 'designMode'
}

/** Chrome's keys while the browser has focus; fixed, since main forwards them before any keymap is loaded */
export function browserAction({ code, meta, shift, alt, control }: KeyInput): BrowserAction | null {
  if (!meta || control) return null
  return ACTIONS[`${shift ? '⇧' : ''}${alt ? '⌥' : ''}${code}`] ?? null
}

/** ⌘ keys the page keeps: editing, undo and redo, find */
const PAGE_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyF', 'KeyG'])

/** Native menu roles: quit, hide, minimize, full screen, zoom, force reload. They only work if the key reaches the menu untouched */
const MENU_KEYS = new Set(['KeyQ', 'KeyH', 'KeyM', '⌃KeyF', 'Equal', '⇧Equal', 'Minus', 'Digit0', '⇧KeyR'])
const isMenuKey = ({ code, shift, control }: KeyInput): boolean => MENU_KEYS.has(`${control ? '⌃' : ''}${shift ? '⇧' : ''}${code}`)

/** Any other ⌘ key is the app's, e.g. ⌘K for the palette, so a focused page doesn't swallow it */
export const forwardsToApp = (key: KeyInput): boolean => key.meta && !browserAction(key) && !isMenuKey(key) && !(PAGE_KEYS.has(key.code) && !key.alt)
