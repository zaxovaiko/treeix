import { expect, test } from 'bun:test'
import { firefoxCookie } from './firefox'

test('firefoxCookie maps rows, with expiry in seconds or milliseconds', () => {
  const now = 1_800_000_000
  const row = { host: '.example.com', name: 'a', value: 'b', path: '/', expiry: now + 60, isSecure: 1, isHttpOnly: 0, sameSite: 2 }
  expect(firefoxCookie(row, now)).toEqual({ url: 'https://example.com/', name: 'a', value: 'b', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'strict', expirationDate: now + 60 })
  expect(firefoxCookie({ ...row, expiry: (now + 60) * 1000 }, now)?.expirationDate).toBe(now + 60)
  expect(firefoxCookie({ ...row, expiry: now - 1 }, now)).toBeNull()
  expect(firefoxCookie({ ...row, sameSite: 0, isSecure: 0 }, now)?.sameSite).toBe('unspecified')
  expect(firefoxCookie({ ...row, sameSite: 0 }, now)?.sameSite).toBe('no_restriction')
})
