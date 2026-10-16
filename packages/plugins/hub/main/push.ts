import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'
import { isJson, isString } from '@treeix/shared/json'

/** What a browser's PushManager.subscribe() hands back, as JSON */
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } }

export const isPushSubscription = (value: unknown): value is PushSubscription =>
  isJson(value) && isString(value.endpoint) && value.endpoint.startsWith('https://') && isJson(value.keys) && isString(value.keys.p256dh) && isString(value.keys.auth)

/** The server's P-256 key pair, both halves as base64url: the public one is what the page subscribes with */
export type Vapid = { publicKey: string; privateKey: string }

export function createVapid(): Vapid {
  const { d, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
  if (!d || !x || !y) throw new Error('No P-256 key')
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url'), privateKey: d }
}

const RECORD_SIZE = 4096
const TTL_S = 24 * 60 * 60
const JWT_LIFETIME_S = 12 * 60 * 60

/** The payload encrypted for one subscription (RFC 8291, aes128gcm): salt, record size, our one-off public key, then the ciphertext */
export function encrypt(subscription: PushSubscription, payload: string): Buffer {
  const userKey = Buffer.from(subscription.keys.p256dh, 'base64url')
  const ecdh = createECDH('prime256v1')
  const ourKey = ecdh.generateKeys()
  const salt = randomBytes(16)
  const ikm = Buffer.from(
    hkdfSync('sha256', ecdh.computeSecret(userKey), Buffer.from(subscription.keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), userKey, ourKey]), 32)
  )
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  // 0x02 marks the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, recordSize, Buffer.from([ourKey.length]), ourKey, body])
}

/** The VAPID token the push service checks against the public key the page subscribed with (RFC 8292) */
function vapidToken(vapid: Vapid, audience: string, subject: string): string {
  const publicKey = Buffer.from(vapid.publicKey, 'base64url')
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33).toString('base64url') },
    format: 'jwk'
  })
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_S, sub: subject })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/** Sends one notification; false when the push service says the subscription is gone, so it can be forgotten */
export async function sendPush(subscription: PushSubscription, payload: string, vapid: Vapid, subject: string): Promise<boolean> {
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_S),
      Urgency: 'high',
      Authorization: `vapid t=${vapidToken(vapid, new URL(subscription.endpoint).origin, subject)}, k=${vapid.publicKey}`
    },
    body: new Uint8Array(encrypt(subscription, payload))
  })
  if (response.status === 404 || response.status === 410) return false
  if (!response.ok) throw new Error(`Push failed: ${response.status} ${await response.text()}`)
  return true
}
