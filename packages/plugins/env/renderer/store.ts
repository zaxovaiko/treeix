import { useSyncExternalStore } from 'react'
import { createBridge, definePluginSettings, type HostApi } from '@treeix/sdk'
import { baseName, branchLabel } from '@treeix/app/Sidebar'
import type { Repo, Worktree } from '@treeix/shared/types'
import type { Annotation, CopyMode, EnvEdit, Usage, WorktreeEnv } from '../shared/types'

export const TAB_ID = 'env'

const bridge = createBridge('env')

export const envApi = {
  scan: (paths: string[]) => bridge.invoke<WorktreeEnv[]>('scan', paths),
  write: (edits: EnvEdit[]) => bridge.invoke<void>('write', edits),
  mark: (worktreePath: string, folder: string, name: string, annotation: Annotation) => bridge.invoke<void>('mark', worktreePath, folder, name, annotation),
  copyFromMain: (mainPath: string, worktreePath: string, files: string[], mode: CopyMode) => bridge.invoke<number>('copyFromMain', mainPath, worktreePath, files, mode),
  usages: (worktreePath: string, name: string) => bridge.invoke<Usage[]>('usages', worktreePath, name),
  /** Watches only this worktree's files, replacing the last call; null stops */
  watch: (worktreePath: string | null, files: string[] = []) => bridge.invoke<void>('watch', worktreePath, files),
  onChanged: (listener: (worktreePath: string) => void) => bridge.on('changed', (path) => typeof path === 'string' && listener(path))
}

/** A value held in memory only: env values and unsaved edits never go to localStorage */
function memoryStore<T>(initial: T): { get: () => T; set: (next: T) => void; use: () => T } {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => value,
    set: (next) => {
      value = next
      listeners.forEach((listener) => listener())
    },
    use: () => useSyncExternalStore(subscribe, () => value)
  }
}

/** Scans by worktree path */
export const envs = memoryStore<ReadonlyMap<string, WorktreeEnv>>(new Map())
export const scanning = memoryStore(false)

/** Rescans the given worktrees and keeps what is known about the others */
export async function rescan(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  scanning.set(true)
  try {
    const scanned = await envApi.scan(paths)
    envs.set(new Map([...envs.get(), ...scanned.map((env): [string, WorktreeEnv] => [env.path, env])]))
  } finally {
    scanning.set(false)
  }
}

/** Unsaved values by editKey */
export const pending = memoryStore<ReadonlyMap<string, EnvEdit>>(new Map())
export const editKey = (worktreePath: string, file: string, name: string): string => `${worktreePath}|${file}|${name}`

export function setPending(edit: EnvEdit, original: string | null): void {
  const next = new Map(pending.get())
  const key = editKey(edit.worktreePath, edit.file, edit.name)
  if (edit.value === (original ?? '')) next.delete(key)
  else next.set(key, edit)
  pending.set(next)
}

const COPY_MODES: CopyMode[] = ['copy', 'symlink', 'example']
const isCopyMode = (value: unknown): value is CopyMode => COPY_MODES.some((mode) => mode === value)

export const envSettings = definePluginSettings('env', (stored) => {
  const auto = typeof stored.autoCopy === 'object' && stored.autoCopy !== null ? Object.entries(stored.autoCopy) : []
  /** What new worktrees of a repository get from main, by repository path */
  const autoCopy: Record<string, CopyMode> = Object.fromEntries(auto.filter((entry): entry is [string, CopyMode] => isCopyMode(entry[1])))
  return { autoCopy }
})

/** Opening a variable from the palette; the page picks it up */
export const openRequest = definePluginSettings('env-open', () => ({ name: null as string | null }))

export type ScopedWorktree = { repo: Repo; worktree: Worktree; isMain: boolean; env: WorktreeEnv | undefined; main: WorktreeEnv | undefined }

/** Repositories of the workspace and sidebar scope; git lists a repository's main worktree first */
export function scopedWorktrees(host: Pick<HostApi, 'repos' | 'scopeRepoPaths'>, known: ReadonlyMap<string, WorktreeEnv>): ScopedWorktree[] {
  const repos = (host.repos ?? []).filter((repo) => host.scopeRepoPaths?.includes(repo.path))
  return repos.flatMap((repo) =>
    repo.worktrees.map((worktree, index) => ({ repo, worktree, isMain: index === 0, env: known.get(worktree.path), main: known.get(repo.worktrees[0].path) }))
  )
}

export const worktreeTitle = ({ repo, worktree }: Pick<ScopedWorktree, 'repo' | 'worktree'>): string => `${baseName(repo.path)} ${branchLabel(worktree)}`

/** Copies main's env files into a worktree; resolves with how many files were created */
export function copyFromMain(target: ScopedWorktree, mode: CopyMode, files = target.main?.files.map((file) => file.path) ?? []): Promise<number> {
  return envApi.copyFromMain(target.repo.worktrees[0].path, target.worktree.path, files, mode).then(async (created) => {
    await rescan([target.worktree.path])
    return created
  })
}
