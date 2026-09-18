const MAX_ENTRIES = 50

/** Visited places, oldest first; `index` is the current one */
export type NavigationHistory<T> = { entries: T[]; index: number }

export const emptyHistory = <T>(): NavigationHistory<T> => ({ entries: [], index: -1 })

/** Adds a place after the current one, dropping the forward entries like a browser; repeats of the current place are ignored */
export function recordPlace<T>(history: NavigationHistory<T>, place: T, same: (a: T, b: T) => boolean): NavigationHistory<T> {
  const current = history.entries[history.index]
  if (current !== undefined && same(current, place)) return history
  const entries = [...history.entries.slice(0, history.index + 1), place].slice(-MAX_ENTRIES)
  return { entries, index: entries.length - 1 }
}

/** The place `delta` steps back (-1) or forward (1), or null at either end */
export function stepPlace<T>(history: NavigationHistory<T>, delta: -1 | 1): { history: NavigationHistory<T>; place: T } | null {
  const index = history.index + delta
  const place = history.entries[index]
  return place === undefined ? null : { history: { ...history, index }, place }
}
