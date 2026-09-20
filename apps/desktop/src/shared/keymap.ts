import { matchesShortcut, type Shortcut, shortcutLabel } from './shortcut'

/**
 * Every named action the keyboard can reach, with the key it ships with. The app and its plugins declare theirs
 * here, Settings rebinds them, and the shortcut sheet lists them; nothing else knows which key runs what.
 */
export type ActionDef = {
  /** `area.verb`, e.g. `shell.zen` or `prs.merge` */
  id: string
  label: string
  /** Groups the action in Settings and in the shortcut sheet */
  section: string
  /** Tab id when the key only works on that page */
  page?: string
  /** The key it ships with; null for actions that start unbound */
  keys: Shortcut | null
}

export const key = (code: string, modifiers: Partial<Shortcut> = {}): Shortcut => ({ code, meta: false, alt: false, ctrl: false, shift: false, ...modifiers })

const registry = new Map<string, ActionDef>()
/** Rebound keys from Settings; an id set to null is unbound on purpose */
let overrides: Record<string, Shortcut | null> = {}
const listeners = new Set<() => void>()

/** Declared once per module load, so plugins can register theirs as they are imported */
export function defineActions(defs: ActionDef[]): ActionDef[] {
  for (const def of defs) registry.set(def.id, def)
  listeners.forEach((listener) => listener())
  return defs
}

export const actionList = (): ActionDef[] => [...registry.values()]
export const actionOf = (id: string): ActionDef | undefined => registry.get(id)

export function setKeymapOverrides(next: Record<string, Shortcut | null>): void {
  overrides = next
  listeners.forEach((listener) => listener())
}

export function onKeymapChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The key an action runs on now: the rebound one, else the one it ships with */
export const shortcutOf = (id: string): Shortcut | null => (Object.hasOwn(overrides, id) ? overrides[id] : (registry.get(id)?.keys ?? null))

export const isRebound = (id: string): boolean => Object.hasOwn(overrides, id)

export const matchesAction = (event: KeyboardEvent, id: string): boolean => matchesShortcut(event, shortcutOf(id))

/** The first of `ids` whose key the event matches, for handlers that dispatch a whole page's keys at once */
export const actionForEvent = (event: KeyboardEvent, ids: string[]): string | undefined => ids.find((id) => matchesAction(event, id))

/** "⌘⇧E" for the sheet, palette and tooltips; empty when the action has no key */
export function actionKeys(id: string): string {
  const shortcut = shortcutOf(id)
  return shortcut ? shortcutLabel(shortcut) : ''
}

const sameShortcut = (a: Shortcut | null, b: Shortcut | null): boolean =>
  a !== null && b !== null && a.code === b.code && a.meta === b.meta && a.alt === b.alt && a.ctrl === b.ctrl && a.shift === b.shift

/** Ids sharing one key, so Settings can flag the clash; actions of different pages may share freely */
export function conflictsOf(id: string): string[] {
  const shortcut = shortcutOf(id)
  const page = registry.get(id)?.page
  if (!shortcut) return []
  return actionList()
    .filter((def) => def.id !== id && (def.page === undefined || page === undefined || def.page === page) && sameShortcut(shortcut, shortcutOf(def.id)))
    .map((def) => def.id)
}
