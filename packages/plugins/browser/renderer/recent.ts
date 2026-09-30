import { useSyncExternalStore } from 'react'
import { list, parseJson } from '@treeix/shared/json'

export type RecentPage = { url: string; title: string }

export const RECENT_LIMIT = 20
const KEY = 'browser.recent'

const isRecentPage = (value: unknown): value is RecentPage =>
  typeof value === 'object' && value !== null && 'url' in value && 'title' in value && typeof value.url === 'string' && typeof value.title === 'string'

export const parseRecent = (raw: string | null): RecentPage[] => list(parseJson(raw), isRecentPage).slice(0, RECENT_LIMIT)

/** Newest first, one entry per URL, web pages only */
export function withVisit(list: RecentPage[], url: string): RecentPage[] {
  if (!/^https?:\/\//i.test(url)) return list
  const title = list.find((entry) => entry.url === url)?.title ?? ''
  return [{ url, title }, ...list.filter((entry) => entry.url !== url)].slice(0, RECENT_LIMIT)
}

export const withTitle = (list: RecentPage[], url: string, title: string): RecentPage[] => list.map((entry) => (entry.url === url ? { ...entry, title } : entry))

let recent: RecentPage[] | null = null
const listeners = new Set<() => void>()
const getRecent = (): RecentPage[] => (recent ??= parseRecent(localStorage.getItem(KEY)))

function change(next: RecentPage[]): void {
  if (next === recent) return
  recent = next
  localStorage.setItem(KEY, JSON.stringify(next))
  listeners.forEach((listener) => listener())
}

export const recordVisit = (url: string): void => change(withVisit(getRecent(), url))
export const recordTitle = (url: string, title: string): void => {
  if (getRecent().some((entry) => entry.url === url && entry.title !== title)) change(withTitle(getRecent(), url, title))
}

export const clearRecent = (): void => change([])

export const useRecent = (): RecentPage[] =>
  useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, getRecent)
