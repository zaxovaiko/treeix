import { shell, type WebContents } from 'electron'
import { type Stats, unwatchFile, watchFile as watchFileStat } from 'node:fs'
import { mkdir, readdir, rename, stat, writeFile as writeFileText } from 'node:fs/promises'
import { dirname } from 'node:path'
import { insideWorktree } from './paths'

export { saveFile } from './paths'

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

const WATCH_INTERVAL_MS = 1000
const watchers = new Map<string, { absolute: string; listener: (current: Stats, previous: Stats) => void }>()

/** Stat polling rather than fs.watch: agents and editors often replace files by rename, which fs.watch stops following */
export function watchFile(sender: WebContents, id: string, worktreePath: string, filePath: string): void {
  const absolute = insideWorktree(worktreePath, filePath)
  const listener = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    if (!sender.isDestroyed()) sender.send('file-changed', id)
  }
  watchFileStat(absolute, { interval: WATCH_INTERVAL_MS, persistent: false }, listener)
  watchers.set(id, { absolute, listener })
  sender.once('destroyed', () => stopWatching(id))
}

export function stopWatching(id: string): void {
  const watcher = watchers.get(id)
  if (watcher) unwatchFile(watcher.absolute, watcher.listener)
  watchers.delete(id)
}

/** One level of a folder, relative to `root`, folders ending in /; for browsing outside a repository, where listing everything at once is too slow */
export async function listDirectory(root: string, folder: string): Promise<string[]> {
  const entries = await readdir(folder ? insideWorktree(root, folder) : root, { withFileTypes: true }).catch(() => [])
  const prefix = folder ? `${folder}/` : ''
  return entries.filter((entry) => entry.name !== '.DS_Store').map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
}

/** New empty file or folder (path ending in /), creating missing parent folders */
export async function createPath(worktreePath: string, filePath: string): Promise<void> {
  const absolute = insideWorktree(worktreePath, filePath)
  if (await exists(absolute)) throw new Error(`${filePath} already exists`)
  if (filePath.endsWith('/')) return void (await mkdir(absolute, { recursive: true }))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFileText(absolute, '', { flag: 'wx' })
}

export async function renamePath(worktreePath: string, from: string, to: string): Promise<void> {
  const target = insideWorktree(worktreePath, to)
  if (await exists(target)) throw new Error(`${to} already exists`)
  await mkdir(dirname(target), { recursive: true })
  await rename(insideWorktree(worktreePath, from), target)
}

/** Moves to the system Trash rather than deleting, so a wrong click is recoverable */
export const trashPath = (worktreePath: string, filePath: string): Promise<void> => shell.trashItem(insideWorktree(worktreePath, filePath))
