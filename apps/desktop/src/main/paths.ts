import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** Absolute path of `filePath` inside the worktree; throws for anything that escapes it */
export function insideWorktree(worktreePath: string, filePath: string): string {
  const absolute = resolve(worktreePath, filePath)
  const path = relative(worktreePath, absolute)
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error(`${filePath} is outside the worktree`)
  return absolute
}

export const SAVE_CONFLICT = 'SAVE_CONFLICT'

/**
 * Writes only if the file still holds `expected` (the version the editor loaded); otherwise throws SAVE_CONFLICT
 * so an agent's or another editor's change is never silently overwritten. `expected` null skips the check.
 */
export async function saveFile(worktreePath: string, filePath: string, contents: string, expected: string | null): Promise<void> {
  const absolute = insideWorktree(worktreePath, filePath)
  if (expected !== null) {
    const current = await readFile(absolute, 'utf8').catch(() => null)
    if (current !== expected) throw new Error(SAVE_CONFLICT)
  }
  await writeFile(absolute, contents, 'utf8')
}
