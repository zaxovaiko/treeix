import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry } from '../shared/types'
import { insideWorktree } from './paths'

// Autosave writes every keystroke pause, so keep one snapshot per burst of editing rather than per save
const MIN_SNAPSHOT_GAP_MS = 60_000
const MAX_SNAPSHOTS = 100

const fileDir = (root: string, worktreePath: string, filePath: string): string =>
  join(root, createHash('sha1').update(`${worktreePath}\0${filePath}`).digest('hex'))

const snapshotIds = async (dir: string): Promise<number[]> =>
  (await readdir(dir).catch(() => []))
    .filter((name) => name.endsWith('.txt'))
    .map((name) => Number(name.slice(0, -4)))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)

/** Local edit history kept in app data: the on-disk version is snapshotted before it gets overwritten */
export function createHistory(root: string) {
  return {
    async snapshotBeforeSave(worktreePath: string, filePath: string, now = Date.now()): Promise<void> {
      const current = await readFile(insideWorktree(worktreePath, filePath), 'utf8').catch(() => null)
      if (current === null) return
      const dir = fileDir(root, worktreePath, filePath)
      const [latest, ...older] = await snapshotIds(dir)
      if (latest !== undefined && now - latest < MIN_SNAPSHOT_GAP_MS) return
      if (latest !== undefined && (await readFile(join(dir, `${latest}.txt`), 'utf8').catch(() => null)) === current) return
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${now}.txt`), current)
      await writeFile(join(dir, 'file.json'), JSON.stringify({ worktreePath, filePath }))
      const stale = [latest, ...older].filter((id) => id !== undefined).slice(MAX_SNAPSHOTS - 1)
      await Promise.all(stale.map((id) => rm(join(dir, `${id}.txt`), { force: true })))
    },

    async list(worktreePath: string, filePath: string): Promise<HistoryEntry[]> {
      const dir = fileDir(root, worktreePath, filePath)
      return Promise.all(
        (await snapshotIds(dir)).map(async (id) => ({ id: String(id), savedAt: id, bytes: (await stat(join(dir, `${id}.txt`))).size }))
      )
    },

    read: (worktreePath: string, filePath: string, id: string): Promise<string> => {
      if (!/^\d+$/.test(id)) throw new Error('Invalid snapshot id')
      return readFile(join(fileDir(root, worktreePath, filePath), `${id}.txt`), 'utf8')
    }
  }
}
