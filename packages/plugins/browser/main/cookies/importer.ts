import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { CookiesSetDetails, Session } from 'electron'
import type { ImportResult } from '../../shared/types'
import { type ChromiumRow, chromiumCookie, chromiumKey, decryptChromiumValue, metaVersion } from './chromium'
import { type FirefoxRow, firefoxCookie } from './firefox'
import { isBlocked, profileSource } from './profiles'

const run = promisify(execFile)
const BATCH = 200

type SqlRow = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const int = (value: unknown): number => (typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0)
const bytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : new Uint8Array())

const firefoxRow = (row: SqlRow): FirefoxRow => ({
  host: text(row.host),
  name: text(row.name),
  value: text(row.value),
  path: text(row.path),
  expiry: int(row.expiry),
  isSecure: int(row.isSecure),
  isHttpOnly: int(row.isHttpOnly),
  sameSite: int(row.sameSite)
})

const chromiumRow = (row: SqlRow): ChromiumRow => ({
  host_key: text(row.host_key),
  name: text(row.name),
  path: text(row.path),
  expires_utc: typeof row.expires_utc === 'bigint' ? row.expires_utc : int(row.expires_utc),
  is_secure: int(row.is_secure),
  is_httponly: int(row.is_httponly),
  samesite: int(row.samesite),
  has_expires: int(row.has_expires)
})

/** macOS asks the user once whether Treeix may read this item; the password stays in the importer */
async function keychainPassword(service: string): Promise<string> {
  const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', service])
  return stdout.trim()
}

async function setAll(target: Session, cookies: (CookiesSetDetails | null)[]): Promise<{ imported: number; skipped: number }> {
  const valid = cookies.filter((cookie): cookie is CookiesSetDetails => cookie !== null)
  let imported = 0
  let skipped = cookies.length - valid.length
  for (let at = 0; at < valid.length; at += BATCH) {
    // Host-only cookies must not carry a domain key at all, or Electron turns them into domain cookies
    const results = await Promise.allSettled(valid.slice(at, at + BATCH).map(({ domain, ...cookie }) => target.cookies.set(domain ? { ...cookie, domain } : cookie)))
    for (const result of results) {
      if (result.status === 'fulfilled') imported++
      else skipped++
    }
  }
  return { imported, skipped }
}

function readFirefox(db: DatabaseSync, now: number): (CookiesSetDetails | null)[] {
  // Container tabs keep their own cookies under the same names; only the default ones are imported
  const rows = db.prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''").all()
  return rows.map((row) => firefoxCookie(firefoxRow(row), now))
}

function readChromium(db: DatabaseSync, password: string, now: number): (CookiesSetDetails | null)[] {
  const key = chromiumKey(password)
  const version = metaVersion(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value)
  const query = db.prepare('SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies')
  // expires_utc is microseconds since 1601, past Number.MAX_SAFE_INTEGER
  query.setReadBigInts(true)
  return query.all().map((row) => {
    const value = text(row.value) || decryptChromiumValue(bytes(row.encrypted_value), key, version)
    return value === null ? null : chromiumCookie(chromiumRow(row), value, now)
  })
}

/** Copies another browser's cookies into the built-in browser's session; a one-off copy, not a sync */
export async function importCookies(key: string, target: Session): Promise<ImportResult> {
  const source = await profileSource(key)
  if (!source) return { imported: 0, skipped: 0, error: 'That browser profile is gone' }
  // The browser keeps its database locked while running, so read a copy
  let folder: string | null = null
  try {
    folder = await mkdtemp(join(tmpdir(), 'treeix-cookies-'))
    const copy = join(folder, 'cookies.sqlite')
    await copyFile(source.cookiesPath, copy)
    // Firefox keeps recent writes in the write-ahead log; the copy is ours, so SQLite may open it writable to read the log
    await copyFile(`${source.cookiesPath}-wal`, `${copy}-wal`).catch(() => undefined)
    const db = new DatabaseSync(copy)
    try {
      const now = Math.floor(Date.now() / 1000)
      if (source.kind === 'firefox') return { ...(await setAll(target, readFirefox(db, now))), error: null }
      let password: string
      try {
        password = await keychainPassword(source.keychain)
      } catch {
        return { imported: 0, skipped: 0, error: `Treeix couldn't read ${source.browser}'s cookie key` }
      }
      return { ...(await setAll(target, readChromium(db, password, now))), error: null }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      imported: 0,
      skipped: 0,
      error: isBlocked(error) ? `macOS blocked access to ${source.browser}. Allow Treeix under System Settings > Privacy & Security, then import again` : `Couldn't read ${source.browser}'s cookies`
    }
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true })
  }
}
