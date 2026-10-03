import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readJsonFile } from '@treeix/host/paths'

/** A JSON array on disk, read once; writes go one at a time, through a temp file so a crash never leaves half a file */
export function jsonList<T>(path: string, guard: (value: unknown) => value is T): { get: () => Promise<T[]>; set: (next: T[]) => Promise<void> } {
  let items: Promise<T[]> = readJsonFile(path).then((value) => (Array.isArray(value) ? value.filter(guard) : []))
  let writing = Promise.resolve()
  return {
    get: () => items,
    set: (next) => {
      items = Promise.resolve(next)
      writing = writing.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(`${path}.tmp`, JSON.stringify(next, null, 2))
        await rename(`${path}.tmp`, path)
      })
      return writing
    }
  }
}
