import { actionOf, shortcutOf } from '../../shared/keymap'
import { MENU_SECTIONS, NO_ACCELERATOR, NOT_IN_MENU } from '../../shared/menu'
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

const sectionOrder = (section: string): number => MENU_SECTIONS.findIndex(([candidate]) => candidate === section)

/** Every runnable action of a menu section, with the key it currently answers to */
export function menuActions(): MenuAction[] {
  return [...runners.keys()]
    .flatMap((id) => {
      const action = actionOf(id)
      if (!action || NOT_IN_MENU.has(id) || sectionOrder(action.section) === -1) return []
      const shortcut = NO_ACCELERATOR.has(id) ? null : shortcutOf(id)
      const accelerator = shortcut ? toAccelerator(shortcut) : null
      return [{ id, label: action.menuLabel ?? action.label, section: action.section, ...(accelerator ? { accelerator } : {}) }]
    })
    .sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section))
}
