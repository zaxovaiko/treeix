import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import type { CookiesSetDetails } from 'electron'

/** Seconds between 1601-01-01, Chromium's epoch, and 1970-01-01 */
const WINDOWS_EPOCH_OFFSET = 11644473600
/** From this cookie database version on, the plaintext starts with a SHA-256 of the cookie's host */
const HOST_HASH_VERSION = 24

export type ChromiumRow = { host_key: string; name: string; path: string; expires_utc: number | bigint; is_secure: number; is_httponly: number; samesite: number; has_expires: number }

/** macOS Chromium: PBKDF2-SHA1 over the Keychain password, salt "saltysalt", 1003 rounds, 16 bytes */
export const chromiumKey = (password: string): Buffer => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')

export function decryptChromiumValue(encrypted: Uint8Array, key: Buffer, dbVersion: number): string | null {
  const data = Buffer.from(encrypted)
  const prefix = data.subarray(0, 3).toString()
  if (prefix !== 'v10' && prefix !== 'v11') return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()])
    return (dbVersion >= HOST_HASH_VERSION ? plain.subarray(32) : plain).toString('utf8')
  } catch {
    return null
  }
}

/** Chromium stores meta values as text; older databases may hold integers */
export function metaVersion(value: unknown): number {
  const version = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0
  return Number.isFinite(version) ? version : 0
}

/** Chromium and Firefox share these codes; anything else leaves the browser's default */
export const SAME_SITE: Record<number, CookiesSetDetails['sameSite']> = { 0: 'no_restriction', 1: 'lax', 2: 'strict' }

export const cookieUrl = (host: string, path: string, secure: boolean): string => `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${path || '/'}`

/** Session cookies and expired ones are skipped: the import copies what would survive a relaunch */
export function chromiumCookie(row: ChromiumRow, value: string, nowSeconds: number): CookiesSetDetails | null {
  if (!row.has_expires) return null
  const expirationDate = Math.floor(Number(row.expires_utc) / 1_000_000 - WINDOWS_EPOCH_OFFSET)
  if (expirationDate <= nowSeconds) return null
  const secure = row.is_secure === 1
  return {
    url: cookieUrl(row.host_key, row.path, secure),
    name: row.name,
    value,
    domain: row.host_key.startsWith('.') ? row.host_key : undefined,
    path: row.path,
    secure,
    httpOnly: row.is_httponly === 1,
    sameSite: SAME_SITE[row.samesite] ?? 'unspecified',
    expirationDate
  }
}
