import type { PullRequestList } from '../shared/types'
import { api } from './api'

const STORAGE_KEY = 'prs.cache'
/** Scopes kept on disk; older ones are dropped so storage stays small */
const MAX_SCOPES = 12

type Entry = { list: PullRequestList; fetchedAt: number }

const lists = new Map<string, Entry>(loadStored())
const inFlight = new Map<string, Promise<PullRequestList>>()
const listeners = new Set<(scopeKey: string) => void>()

function loadStored(): [string, Entry][] {
  if (typeof localStorage === 'undefined') return []
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((entry): entry is [string, Entry] => Array.isArray(entry) && typeof entry[0] === 'string') : []
  } catch {
    return []
  }
}

export const scopeKeyOf = (repoPaths: string[]): string => repoPaths.join('\n')

/** The last list fetched for these repositories, from this run or an earlier one */
export const cachedPullRequests = (scopeKey: string): PullRequestList | null => lists.get(scopeKey)?.list ?? null

export const lastFetched = (scopeKey: string): number => lists.get(scopeKey)?.fetchedAt ?? 0

export function onPullRequestsUpdated(listener: (scopeKey: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Fetches the list, sharing a request already running for the same repositories, then stores and announces it */
export function refreshPullRequests(repoPaths: string[]): Promise<PullRequestList> {
  const scopeKey = scopeKeyOf(repoPaths)
  const running = inFlight.get(scopeKey)
  if (running) return running
  const request = api
    .listPullRequests(repoPaths)
    .then((list) => {
      lists.delete(scopeKey)
      lists.set(scopeKey, { list, fetchedAt: Date.now() })
      const kept = [...lists].slice(-MAX_SCOPES)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept))
      listeners.forEach((listener) => listener(scopeKey))
      return list
    })
    .finally(() => inFlight.delete(scopeKey))
  inFlight.set(scopeKey, request)
  return request
}
