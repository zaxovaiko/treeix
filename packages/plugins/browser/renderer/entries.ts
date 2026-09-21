import { useSyncExternalStore } from 'react'
import { createBridge } from '@treeix/sdk'
import type { ConsoleEntry, EntryBatch, NetworkEntry, Vital } from '../shared/types'

type PageEntries = { console: ConsoleEntry[]; network: NetworkEntry[]; vitals: Vital[] }

const LIMIT = 500
const empty: PageEntries = { console: [], network: [], vitals: [] }
const pages = new Map<number, PageEntries>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

const merge = (current: NetworkEntry[], updates: NetworkEntry[]): NetworkEntry[] => {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of updates) byId.set(entry.id, entry)
  return [...byId.values()].slice(-LIMIT)
}

export function receive(batch: EntryBatch): void {
  const current = batch.reset ? { ...empty, vitals: pages.get(batch.guestId)?.vitals ?? [] } : (pages.get(batch.guestId) ?? empty)
  pages.set(batch.guestId, { ...current, console: [...current.console, ...batch.console].slice(-LIMIT), network: merge(current.network, batch.network) })
  notify()
}

export function addVital(guestId: number, vital: Vital): void {
  const current = pages.get(guestId) ?? empty
  // One row per metric, except long tasks, which each get their own
  const vitals = vital.name === 'Long task' ? [...current.vitals, vital].slice(-50) : [...current.vitals.filter((entry) => entry.name !== vital.name), vital]
  pages.set(guestId, { ...current, vitals })
  notify()
}

export function clearVitals(guestId: number): void {
  const current = pages.get(guestId)
  if (!current) return
  pages.set(guestId, { ...current, vitals: [] })
  notify()
}

export function dropEntries(guestId: number): void {
  if (pages.delete(guestId)) notify()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useEntries = (guestId: number | null): PageEntries => useSyncExternalStore(subscribe, () => (guestId === null ? empty : (pages.get(guestId) ?? empty)))

createBridge('browser').on('entries', (batch) => receive(batch as EntryBatch))
