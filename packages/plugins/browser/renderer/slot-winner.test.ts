import { expect, test } from 'bun:test'
import { pickWinner } from './slot-winner'

const div = (rect: { width: number; height: number }, connected = true): HTMLDivElement =>
  ({ isConnected: connected, getBoundingClientRect: () => rect }) as unknown as HTMLDivElement

test('pickWinner picks the newest mounted slot that is actually visible', () => {
  const hidden = div({ width: 0, height: 0 })
  const visible = div({ width: 319, height: 480 })
  expect(pickWinner([visible, hidden])).toBe(visible)
})

test('pickWinner returns null when no slot is visible', () => {
  expect(pickWinner([div({ width: 0, height: 0 }), div({ width: 10, height: 0 })])).toBeNull()
})

test('pickWinner skips a disconnected slot', () => {
  const disconnected = div({ width: 100, height: 100 }, false)
  const visible = div({ width: 50, height: 50 })
  expect(pickWinner([visible, disconnected])).toBe(visible)
})
