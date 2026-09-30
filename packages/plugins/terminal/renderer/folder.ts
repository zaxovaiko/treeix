import { createStore, type HostApi } from '@treeix/sdk'
import { readStored } from '@treeix/app/storage'
import { isString, list, stringValues } from '@treeix/shared/json'

/** The folder picked on the Terminal page, per workspace; new groups and tabs start there instead of the app's default */
const KEY = 'terminal.folders'
const RECENT_KEY = 'terminal.recentFolders'
const RECENT_LIMIT = 5

const folders = createStore({ picked: stringValues(readStored(KEY)), recent: list(readStored(RECENT_KEY), isString) })

export function setPickedFolder(workspaceId: string, path: string | null): void {
  const { [workspaceId]: _, ...rest } = folders.get().picked
  const picked = path ? { ...rest, [workspaceId]: path } : rest
  const { recent } = folders.get()
  folders.set({ picked, recent: path ? [path, ...recent.filter((item) => item !== path)].slice(0, RECENT_LIMIT) : recent })
  localStorage.setItem(KEY, JSON.stringify(picked))
  localStorage.setItem(RECENT_KEY, JSON.stringify(folders.get().recent))
}

export const pickedFolder = (workspaceId: string): string | null => folders.get().picked[workspaceId] ?? null
export const recentFolders = (): string[] => folders.get().recent

/** Where terminals start: the picked folder, else the app's default */
export const terminalCwd = (host: HostApi): string => pickedFolder(host.workspaceId) ?? host.defaultCwd

/** Rerenders on a pick; returns the folder terminals start in */
export function useTerminalCwd(host: HostApi): string {
  folders.use()
  return terminalCwd(host)
}

// Open from the folder button or ⌘⇧P, so the key can open the dropdown the page draws
const pickerOpen = createStore(false)
export const setFolderPickerOpen = pickerOpen.set
export const useFolderPickerOpen = pickerOpen.use
