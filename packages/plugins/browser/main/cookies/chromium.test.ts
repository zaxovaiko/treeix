import { expect, test } from 'bun:test'
import { createCipheriv, createHash } from 'node:crypto'
import { chromiumCookie, chromiumKey, decryptChromiumValue, metaVersion } from './chromium'

const key = chromiumKey('test-password')
const encrypt = (plain: Buffer): Uint8Array => {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()])
}

test('decryptChromiumValue reads v10 values, stripping the host hash on newer databases', () => {
  expect(decryptChromiumValue(encrypt(Buffer.from('abc123')), key, 23)).toBe('abc123')
  const hashed = Buffer.concat([createHash('sha256').update('.example.com').digest(), Buffer.from('abc123')])
  expect(decryptChromiumValue(encrypt(hashed), key, 24)).toBe('abc123')
  expect(decryptChromiumValue(new Uint8Array(), key, 24)).toBeNull()
  expect(decryptChromiumValue(Buffer.from('v20xxxx'), key, 24)).toBeNull()
})

test('chromiumCookie maps rows and skips session and expired cookies', () => {
  const now = 1_800_000_000
  const expires = (now + 3600 + 11644473600) * 1_000_000
  const row = { host_key: '.example.com', name: 'sid', path: '/', expires_utc: expires, is_secure: 1, is_httponly: 1, samesite: 1, has_expires: 1 }
  expect(chromiumCookie(row, 'v', now)).toEqual({ url: 'https://example.com/', name: 'sid', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: now + 3600 })
  expect(chromiumCookie({ ...row, host_key: 'app.example.com', is_secure: 0, samesite: -1 }, 'v', now)).toMatchObject({ url: 'http://app.example.com/', domain: undefined, secure: false, sameSite: 'unspecified' })
  expect(chromiumCookie({ ...row, has_expires: 0 }, 'v', now)).toBeNull()
  expect(chromiumCookie({ ...row, expires_utc: (now - 1 + 11644473600) * 1_000_000 }, 'v', now)).toBeNull()
})

test('metaVersion reads the meta table version whether stored as text or integer', () => {
  expect(metaVersion('24')).toBe(24)
  expect(metaVersion(24)).toBe(24)
  expect(metaVersion(24n)).toBe(24)
  expect(metaVersion('abc')).toBe(0)
  expect(metaVersion(undefined)).toBe(0)
})
