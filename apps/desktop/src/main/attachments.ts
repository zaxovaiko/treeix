import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { app } from 'electron'

const MAX_BYTES = 25 * 1024 * 1024

export const safeFileName = (name: string): string => basename(name).replace(/[^\w.-]+/g, '_').slice(-80) || 'file'

/** Copies land in app data so agents can read them even after the original moves */
export async function saveAttachment(name: string, data: Uint8Array): Promise<string> {
  if (data.byteLength > MAX_BYTES) throw new Error('Attachments are limited to 25 MB')
  const dir = join(app.getPath('userData'), 'attachments')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${randomUUID().slice(0, 8)}-${safeFileName(name)}`)
  await writeFile(path, data)
  return path
}
