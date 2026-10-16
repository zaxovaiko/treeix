import { expect, test } from 'bun:test'
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { encrypt } from './push'

test('a browser can read what we encrypt for it', () => {
  // The browser's side: its key pair and auth secret, then RFC 8291 decryption
  const browser = createECDH('prime256v1')
  const userKey = browser.generateKeys()
  const auth = randomBytes(16)
  const sealed = encrypt({ endpoint: 'https://push.example', keys: { p256dh: userKey.toString('base64url'), auth: auth.toString('base64url') } }, '{"title":"Ship needs you"}')
  const salt = sealed.subarray(0, 16)
  const keyLength = sealed[20]
  const serverKey = sealed.subarray(21, 21 + keyLength)
  const body = sealed.subarray(21 + keyLength)
  const ikm = Buffer.from(hkdfSync('sha256', browser.computeSecret(serverKey), auth, Buffer.concat([Buffer.from('WebPush: info\0'), userKey, serverKey]), 32))
  const decipher = createDecipheriv(
    'aes-128-gcm',
    Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16)),
    Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  )
  decipher.setAuthTag(body.subarray(-16))
  const plain = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()])
  expect(sealed.readUInt32BE(16)).toBe(4096)
  expect(plain.subarray(0, -1).toString()).toBe('{"title":"Ship needs you"}')
  expect(plain.at(-1)).toBe(2)
})
