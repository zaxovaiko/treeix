import type { Direction } from './state'

/** Everything a key, the app menu (its item ids) or the palette can trigger */
export type CommandId =
  | 'new-shell'
  | 'new-claude'
  | 'new-codex'
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
  | `tab-${number}`
  | `focus-${Direction}`

const MENU_IDS = new Set<string>(['new-shell', 'new-claude', 'new-codex', 'split-right', 'split-down', 'close-pane', 'next-tab', 'prev-tab', 'palette', 'toggle-sidebar', 'settings', 'toggle-tabs', 'toggle-ui', 'toggle-theme'])

export const isCommandId = (id: string): id is CommandId => MENU_IDS.has(id) || /^tab-[1-9]$/.test(id) || /^focus-(left|right|up|down)$/.test(id)

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

// ponytail: macOS Cmd only; Linux gets Ctrl+Shift bindings when it ships
export function shortcut(e: Keys): CommandId | null {
  if (!e.metaKey || e.ctrlKey) return null
  if (e.altKey) return ARROWS[e.key] && !e.shiftKey ? `focus-${ARROWS[e.key]}` : null
  const key = e.key.toLowerCase()
  if (e.shiftKey) {
    if (e.code === 'BracketLeft') return 'prev-tab'
    if (e.code === 'BracketRight') return 'next-tab'
    if (key === 'd') return 'split-down'
    if (key === 'p') return 'palette'
    return null
  }
  if (/^[1-9]$/.test(e.key)) return `tab-${Number(e.key)}`
  if (e.code === 'Backslash') return 'toggle-sidebar'
  const plain: Record<string, CommandId> = { t: 'new-shell', d: 'split-right', w: 'close-pane', k: 'palette', ',': 'settings' }
  return plain[key] ?? null
}
