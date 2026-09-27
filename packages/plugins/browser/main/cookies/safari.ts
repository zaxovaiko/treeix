import type { CookiesSetDetails } from 'electron'
import { cookieUrl } from './chromium'

/** Seconds between 1970-01-01 and 2001-01-01, Safari's epoch */
const MAC_EPOCH_OFFSET = 978_307_200
const SECURE = 1
const HTTP_ONLY = 4

const stringAt = (bytes: Buffer, start: number): string => bytes.toString('utf8', start, bytes.indexOf(0, start))

/**
 * Safari's Cookies.binarycookies: "cook", a big-endian page count and page sizes, then pages whose own numbers are
 * little-endian. Each cookie holds flags, offsets to its null-terminated strings, and an expiry in seconds since 2001.
 * The file keeps persistent cookies only; expired ones are skipped.
 */
export function safariCookies(file: Buffer, nowSeconds: number): (CookiesSetDetails | null)[] {
  if (file.toString('latin1', 0, 4) !== 'cook') throw new Error('Not a Safari cookies file')
  const pageCount = file.readUInt32BE(4)
  const cookies: (CookiesSetDetails | null)[] = []
  let pageStart = 8 + pageCount * 4
  for (let page = 0; page < pageCount; page++) {
    const size = file.readUInt32BE(8 + page * 4)
    const bytes = file.subarray(pageStart, pageStart + size)
    const count = bytes.readUInt32LE(4)
    for (let index = 0; index < count; index++) {
      const cookie = bytes.subarray(bytes.readUInt32LE(8 + index * 4))
      const flags = cookie.readUInt32LE(8)
      const host = stringAt(cookie, cookie.readUInt32LE(16))
      const path = stringAt(cookie, cookie.readUInt32LE(24))
      const expirationDate = Math.floor(cookie.readDoubleLE(40) + MAC_EPOCH_OFFSET)
      const secure = (flags & SECURE) !== 0
      cookies.push(
        expirationDate <= nowSeconds
          ? null
          : {
              url: cookieUrl(host, path, secure),
              name: stringAt(cookie, cookie.readUInt32LE(20)),
              value: stringAt(cookie, cookie.readUInt32LE(28)),
              domain: host.startsWith('.') ? host : undefined,
              path,
              secure,
              httpOnly: (flags & HTTP_ONLY) !== 0,
              sameSite: 'unspecified',
              expirationDate
            }
      )
    }
    pageStart += size
  }
  return cookies
}
