import { expect, test } from 'bun:test'
import { FRAME, ackBatcher, attachStream, bytesFrom, parseFrame } from './stream'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('acks at once when the byte mark is reached', () => {
  const sent: number[] = []
  const acks = ackBatcher((n) => sent.push(n), 100, 1000)
  acks.rendered(60)
  expect(sent).toEqual([])
  acks.rendered(50)
  expect(sent).toEqual([110])
  acks.flush()
  expect(sent).toEqual([110])
})

test('acks small writes after the idle tick, batched', async () => {
  const sent: number[] = []
  const acks = ackBatcher((n) => sent.push(n), 100, 5)
  acks.rendered(1)
  acks.rendered(2)
  await sleep(20)
  expect(sent).toEqual([3])
  acks.rendered(4)
  acks.flush()
  await sleep(20)
  expect(sent).toEqual([3, 4])
})

test('drops what the snapshot already covers', () => {
  const chunk = new Uint8Array([1, 2, 3, 4])
  expect(bytesFrom(chunk, 10, 10)).toEqual(chunk)
  expect(bytesFrom(chunk, 10, 12)).toEqual(new Uint8Array([3, 4]))
  expect(bytesFrom(chunk, 10, 20).length).toBe(0)
})

const frame = (kind: number, seq: number, payload: number[]): ArrayBuffer => {
  const buffer = new ArrayBuffer(9 + payload.length)
  const view = new DataView(buffer)
  view.setUint8(0, kind)
  view.setBigUint64(1, BigInt(seq), true)
  new Uint8Array(buffer, 9).set(payload)
  return buffer
}

test('parses the kind, the little-endian seq and the payload', () => {
  const parsed = parseFrame(frame(FRAME.resync, 0x0102_0304_0506, [7, 8]))
  expect(parsed.kind).toBe(FRAME.resync)
  expect(parsed.seq).toBe(0x0102_0304_0506)
  expect([...parsed.bytes]).toEqual([7, 8])
  expect(parseFrame(frame(FRAME.data, 0, [])).bytes.length).toBe(0)
})

/** A term that renders at once and logs what it got as text */
function fakeTerm() {
  const writes: string[] = []
  const term = {
    write(data: Uint8Array, callback?: () => void) {
      writes.push(new TextDecoder().decode(data))
      callback?.()
    }
  }
  return { term, writes }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

test('a resync resets to its snapshot and seq bookkeeping continues from its seq', () => {
  const { term, writes } = fakeTerm()
  const acked: number[] = []
  let drawn = 0
  const stream = attachStream(term, (n, seq) => {
    acked.push(n)
    drawn = seq
  })
  stream.onData(bytes('abcd'), 8)
  stream.snapshot(bytes('screen'), 10)
  expect(writes).toEqual(['screen', 'cd'])
  expect(drawn).toBe(12)
  stream.onData(bytes('ef'), 12)
  // The daemon skipped 12..100 while this view lagged
  stream.onData(bytes('SCREEN'), 100, true)
  expect(drawn).toBe(100)
  stream.onData(bytes('gh'), 100)
  expect(writes).toEqual(['screen', 'cd', 'ef', '\x1bc', 'SCREEN', 'gh'])
  expect(drawn).toBe(102)
  expect(acked).toEqual([0, 4, 2, 0, 2])
})

test('a resync that comes before the attach reply waits for the snapshot', () => {
  const { term, writes } = fakeTerm()
  const stream = attachStream(term, () => {})
  stream.onData(bytes('late'), 50, true)
  stream.onData(bytes('xy'), 50)
  stream.snapshot(bytes('first'), 10)
  expect(writes).toEqual(['first', '\x1bc', 'late', 'xy'])
})
