import { useSyncExternalStore } from 'react'
import type { HostApi } from '@treeix/sdk'

/** The folder picked on the Terminal page, per workspace; new groups and tabs start there instead of the app's default */
const KEY = 'terminal.folders'
const RECENT_KEY = 'terminal.recentFolders'
const RECENT_LIMIT = 5

const readRecord = (key: string): Record<string, string> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
  } catch {
    return {}
  }
}

const readList = (key: string): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

let picked = readRecord(KEY)
let recent = readList(RECENT_KEY)
const listeners = new Set<() => void>()

export function setPickedFolder(workspaceId: string, path: string | null): void {
  const { [workspaceId]: _, ...rest } = picked
  picked = path ? { ...rest, [workspaceId]: path } : rest
  if (path) recent = [path, ...recent.filter((item) => item !== path)].slice(0, RECENT_LIMIT)
  localStorage.setItem(KEY, JSON.stringify(picked))
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const pickedFolder = (workspaceId: string): string | null => picked[workspaceId] ?? null
export const recentFolders = (): string[] => recent

/** Where terminals start: the picked folder, else the app's default */
export const terminalCwd = (host: HostApi): string => pickedFolder(host.workspaceId) ?? host.defaultCwd

/** Rerenders on a pick; returns the folder terminals start in */
export function useTerminalCwd(host: HostApi): string {
  useSyncExternalStore(subscribe, () => picked)
  return terminalCwd(host)
}

// Open from the folder button or ⌘⇧P, so the key can open the dropdown the page draws
let pickerOpen = false
const openListeners = new Set<() => void>()
export function setFolderPickerOpen(open: boolean): void {
  pickerOpen = open
  openListeners.forEach((listener) => listener())
}
export const useFolderPickerOpen = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    },
    () => pickerOpen
  )
