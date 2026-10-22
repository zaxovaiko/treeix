import { expect, test } from 'bun:test'
import { ackBatcher, bytesFrom } from './stream'

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
