import { actionOf, shortcutOf } from '../../shared/keymap'
import { toAccelerator } from '../../shared/shortcut'

/** What the native menu shows for one action */
export type MenuAction = { id: string; label: string; section: string; accelerator?: string }

const runners = new Map<string, () => void>()
const listeners = new Set<() => void>()

/**
 * Makes an action runnable from outside its own key handler, which is what puts it in the native menu.
 * An action with no runner never reaches the menu, so page-scoped keys like the diff cursor stay out by themselves.
 */
export function registerActionRunner(id: string, run: () => void): () => void {
  runners.set(id, run)
  listeners.forEach((listener) => listener())
  return () => {
    runners.delete(id)
    listeners.forEach((listener) => listener())
  }
}

export const runAction = (id: string): void => runners.get(id)?.()

export const subscribeRunners = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Sections the native menu carries, in the order their menus appear */
export const MENU_SECTIONS = ['Go to', 'Panels'] as const

/** Every runnable action of a menu section, with the key it currently answers to */
export function menuActions(): MenuAction[] {
  return [...runners.keys()]
    .flatMap((id) => {
      const action = actionOf(id)
      if (!action || !MENU_SECTIONS.some((section) => section === action.section)) return []
      const shortcut = shortcutOf(id)
      const accelerator = shortcut ? toAccelerator(shortcut) : null
      return [{ id, label: action.menuLabel ?? action.label, section: action.section, ...(accelerator ? { accelerator } : {}) }]
    })
    .sort((a, b) => MENU_SECTIONS.indexOf(a.section as (typeof MENU_SECTIONS)[number]) - MENU_SECTIONS.indexOf(b.section as (typeof MENU_SECTIONS)[number]))
}
