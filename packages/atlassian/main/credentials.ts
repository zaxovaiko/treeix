import { safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { Credentials } from '../shared'

// One token for every Atlassian plugin
const file = (): string => join(app.getPath('userData'), 'atlassian-credentials.bin')

/** API token for images and attachments, which acli can't download; encrypted with the macOS keychain key */
export async function saveCredentials(credentials: Credentials | null): Promise<void> {
  if (!credentials) return rm(file(), { force: true })
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available, so the token was not saved')
  await writeFile(file(), safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 })
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(await readFile(file())))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { email, token } = parsed as Record<string, unknown>
    return typeof email === 'string' && typeof token === 'string' ? { email, token } : null
  } catch {
    return null
  }
}
