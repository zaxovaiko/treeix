import { expect, test } from 'bun:test'
import { safariCookies } from './safari'

const MAC_EPOCH_OFFSET = 978_307_200

/** One cookie record: 56-byte header, then url, name, path and value strings */
function record(flags: number, host: string, name: string, path: string, value: string, expiresAt: number): Buffer {
  const strings = [host, name, path, value].map((part) => Buffer.from(`${part}\0`))
  const header = Buffer.alloc(56)
  let offset = header.length
  const offsets = strings.map((part) => ((offset += part.length), offset - part.length))
  header.writeUInt32LE(header.length + strings.reduce((sum, part) => sum + part.length, 0), 0)
  header.writeUInt32LE(flags, 8)
  offsets.forEach((at, index) => header.writeUInt32LE(at, 16 + index * 4))
  header.writeDoubleLE(expiresAt - MAC_EPOCH_OFFSET, 40)
  return Buffer.concat([header, ...strings])
}

function file(records: Buffer[]): Buffer {
  const head = Buffer.alloc(8 + records.length * 4 + 4)
  head.writeUInt32BE(0x100, 0)
  head.writeUInt32LE(records.length, 4)
  let at = head.length
  records.forEach((cookie, index) => ((head.writeUInt32LE(at, 8 + index * 4), (at += cookie.length))))
  const page = Buffer.concat([head, ...records])
  const top = Buffer.alloc(12)
  top.write('cook', 0, 'latin1')
  top.writeUInt32BE(1, 4)
  top.writeUInt32BE(page.length, 8)
  return Buffer.concat([top, page])
}

test('safariCookies reads records, flags and domains, skipping expired ones', () => {
  const now = 1_800_000_000
  const cookies = safariCookies(file([record(5, '.example.com', 'a', '/', 'b', now + 60), record(0, 'host.test', 'c', '/x', 'd', now + 60), record(0, 'old.test', 'e', '/', 'f', now - 1)]), now)
  expect(cookies).toEqual([
    { url: 'https://example.com/', name: 'a', value: 'b', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', expirationDate: now + 60 },
    { url: 'http://host.test/x', name: 'c', value: 'd', domain: undefined, path: '/x', secure: false, httpOnly: false, sameSite: 'unspecified', expirationDate: now + 60 },
    null
  ])
  expect(() => safariCookies(Buffer.from('nope'), now)).toThrow()
})
