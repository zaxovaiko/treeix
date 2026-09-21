import type { MainPlugin } from '@treeix/sdk/main'
import type { Annotation, CopyMode, EnvEdit } from '../shared/types'
import { copyFromMain, markName, scanWorktree, stopWatching, usages, watchWorktree, writeEdits } from './env'

const plugin: MainPlugin = {
  activate: (context) => {
    // A worktree git no longer knows (removed meanwhile) scans as having no env files rather than failing the batch
    context.handle('scan', (_, paths: string[]) => Promise.all(paths.map((path) => scanWorktree(path).catch(() => ({ path, files: [], templates: [], annotations: {} })))))
    context.handle('write', (_, edits: EnvEdit[]) => writeEdits(edits))
    context.handle('mark', (_, worktreePath: string, folder: string, name: string, annotation: Annotation) => markName(worktreePath, folder, name, annotation))
    context.handle('copyFromMain', (_, mainPath: string, worktreePath: string, files: string[], mode: CopyMode) => copyFromMain(mainPath, worktreePath, files, mode))
    context.handle('usages', (_, worktreePath: string, name: string) => usages(worktreePath, name))
    // One watched worktree and one event for all its files, rather than a listener per file
    context.handle('watch', (_, worktreePath: string | null, files: string[]) =>
      worktreePath ? watchWorktree(worktreePath, files, () => context.broadcast('changed', worktreePath)) : stopWatching()
    )
    context.onDispose(stopWatching)
  }
}

export default plugin
