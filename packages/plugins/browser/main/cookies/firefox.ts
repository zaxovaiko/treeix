import type { CookiesSetDetails } from 'electron'
import { SAME_SITE, cookieUrl } from './chromium'

export type FirefoxRow = { host: string; name: string; value: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number }

export function firefoxCookie(row: FirefoxRow, nowSeconds: number): CookiesSetDetails | null {
  // Newer Firefox stores expiry in milliseconds
  const expirationDate = row.expiry > 1e11 ? Math.floor(row.expiry / 1000) : row.expiry
  if (expirationDate <= nowSeconds) return null
  const secure = row.isSecure === 1
  return {
    url: cookieUrl(row.host, row.path, secure),
    name: row.name,
    value: row.value,
    domain: row.host.startsWith('.') ? row.host : undefined,
    path: row.path,
    secure,
    httpOnly: row.isHttpOnly === 1,
    // Firefox stores 0 both for SameSite=None and for no attribute; Chromium rejects None without Secure
    sameSite: row.sameSite === 0 && !secure ? 'unspecified' : (SAME_SITE[row.sameSite] ?? 'unspecified'),
    expirationDate
  }
}
