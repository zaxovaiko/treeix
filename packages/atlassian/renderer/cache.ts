import { useEffect, useState } from 'react'

export type Entry<T> = { value: T; fetchedAt: number }

const MAX_ENTRIES = 40

export const isStale = (entry: Entry<unknown> | null, ttlMs: number, now = Date.now()): boolean => entry === null || now - entry.fetchedAt > ttlMs

/** Newest entries first, capped, so one cache can't fill browser storage */
export const trimEntries = <T>(entries: [string, Entry<T>][], max = MAX_ENTRIES): [string, Entry<T>][] =>
  [...entries].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, max)

const isEntry = (value: unknown): value is Entry<unknown> => typeof value === 'object' && value !== null && typeof (value as Entry<unknown>).fetchedAt === 'number'

export type Cache<T> = {
  get: (id: string) => Entry<T> | null
  set: (id: string, value: T) => void
  clear: () => void
}

/** Survives restarts, so a tab opens on what it showed last time while fresh data loads behind it */
export function persistentCache<T>(name: string, max = MAX_ENTRIES): Cache<T> {
  const key = `cache.${name}`
  const load = (): Map<string, Entry<T>> => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      return new Map(Array.isArray(stored) ? stored.filter((entry): entry is [string, Entry<T>] => Array.isArray(entry) && typeof entry[0] === 'string' && isEntry(entry[1])) : [])
    } catch {
      return new Map()
    }
  }
  const entries = load()
  const save = (): void => {
    const kept = trimEntries([...entries], max)
    entries.clear()
    for (const [id, entry] of kept) entries.set(id, entry)
    try {
      localStorage.setItem(key, JSON.stringify(kept))
    } catch {
      // Out of storage: the cache is expendable, the app is not
      entries.clear()
      localStorage.removeItem(key)
    }
  }
  return {
    get: (id) => entries.get(id) ?? null,
    set: (id, value) => {
      entries.set(id, { value, fetchedAt: Date.now() })
      save()
    },
    clear: () => {
      entries.clear()
      localStorage.removeItem(key)
    }
  }
}

export type Cached<T> = {
  /** What is on screen: the cached value until fresh data arrives */
  value: T | null
  /** When that value was fetched, null while nothing is cached */
  fetchedAt: number | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Shows the cached value at once and fetches behind it, so a tab never waits on the network for what it
 * already had. Refetches when the entry is older than `ttlMs`, and whenever `refresh` is called.
 */
export function useCached<T>(cache: Cache<T>, id: string, ttlMs: number, load: (id: string) => Promise<T>): Cached<T> {
  const cachedEntry = id ? cache.get(id) : null
  const [state, setState] = useState<{ id: string; value: T | null; fetchedAt: number | null }>({ id, value: cachedEntry?.value ?? null, fetchedAt: cachedEntry?.fetchedAt ?? null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  // The value for this id, even on the render where the id just changed
  const entry = state.id === id ? state : { id, value: cachedEntry?.value ?? null, fetchedAt: cachedEntry?.fetchedAt ?? null }

  useEffect(() => {
    if (!id) return
    const known = cache.get(id)
    setState({ id, value: known?.value ?? null, fetchedAt: known?.fetchedAt ?? null })
    setError(null)
    if (reload === 0 && !isStale(known, ttlMs)) return
    let cancelled = false
    setLoading(true)
    load(id)
      .then(
        (value) => {
          cache.set(id, value)
          if (!cancelled) setState({ id, value, fetchedAt: Date.now() })
        },
        (reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        }
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [id, reload])

  return { value: entry.value, fetchedAt: entry.fetchedAt, loading, error, refresh: () => setReload((count) => count + 1) }
}
