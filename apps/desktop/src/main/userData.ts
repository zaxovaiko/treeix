import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'

/** Moves data from the pre-rename folder into `target` once; returns the folder to use. */
export function migrateUserData(legacy: string, target: string): string {
  if (!existsSync(legacy)) return target
  const targetEntries = existsSync(target) ? readdirSync(target).filter((name) => name !== '.DS_Store') : []
  if (targetEntries.length > 0) return target
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(legacy, target)
    return target
  } catch {
    return legacy
  }
}
