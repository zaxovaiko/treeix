import { useSyncExternalStore } from 'react'
import { leaves, newTabId, type Action, type UiState } from '../../shell/state'

/** One file view per place: a pane leaf `file:<root>` holding that place's open files as editor tabs */
const PREFIX = 'file:'

export const fileLeaf = (root: string): string => `${PREFIX}${root}`
export const isFileLeaf = (id: string): boolean => id.startsWith(PREFIX)
export const leafRoot = (id: string): string => id.slice(PREFIX.length)

export interface Reveal {
  line: number
  /** 1-based, as Monaco counts */
  column: number
  /** Bumped per request, so asking for the same line again scrolls back to it */
  seq: number
}

export interface FileTabs {
  files: string[]
  active: string
  reveal: Reveal | null
}

let views: Record<string, FileTabs> = {}
let seq = 0
const listeners = new Set<() => void>()

function set(id: string, next: FileTabs | null): void {
  const { [id]: _, ...rest } = views
  views = next ? { ...rest, [id]: next } : rest
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useFileTabs = (id: string): FileTabs | undefined => useSyncExternalStore(subscribe, () => views[id])

/** `path` against `base`, with `.` and `..` folded */
export const resolvePath = (base: string, path: string): string =>
  `/${(path.startsWith('/') ? path : `${base}/${path}`)
    .split('/')
    .reduce<string[]>((parts, part) => (part === '..' ? parts.slice(0, -1) : part && part !== '.' ? [...parts, part] : parts), [])
    .join('/')}`

type View = { ui: UiState; dispatch: (action: Action) => void }

/** The way into the file view (ShellView.openFile): `file` relative to `root`, at a 1-based line and 0-based column when given */
export function openFile(view: View, root: string, file: string, line?: number, column?: number): void {
  const id = fileLeaf(root)
  const current = views[id]
  const files = current?.files.includes(file) ? current.files : [...(current?.files ?? []), file]
  set(id, { files, active: file, reveal: line ? { line, column: (column ?? 0) + 1, seq: ++seq } : null })
  if (view.ui.tabs.some((tab) => leaves(tab.root).includes(id))) view.dispatch({ type: 'focus', session: id })
  else view.dispatch({ type: 'open', session: id, tabId: newTabId() })
}

export function showFile(id: string, file: string): void {
  const current = views[id]
  if (current) set(id, { ...current, active: file, reveal: null })
}

/** Closing the last file closes the pane */
export function closeFile(view: View, id: string, file: string): void {
  const current = views[id]
  if (!current) return
  const index = current.files.indexOf(file)
  const files = current.files.filter((candidate) => candidate !== file)
  if (!files.length) return closeFileLeaf(view, id)
  const active = current.active === file ? (files[Math.min(index, files.length - 1)] ?? files[0] ?? '') : current.active
  set(id, { files, active, reveal: null })
}

/** The leaf isn't a session, so it leaves the layout without the api's remove */
export function closeFileLeaf(view: View, id: string): void {
  set(id, null)
  view.dispatch({ type: 'remove', session: id })
}
