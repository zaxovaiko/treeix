import { expect, test } from 'bun:test'
import { emptyFeed } from './feed'
import { afterPrompt, emptyChat, statusOf, withUserMessage } from './store'

test('status: waiting beats running beats connected', () => {
  expect(statusOf(emptyChat)).toBe('exited')
  expect(statusOf({ ...emptyChat, connected: true })).toBe('idle')
  expect(statusOf({ ...emptyChat, connected: true, sending: true })).toBe('running')
  expect(statusOf({ ...emptyChat, connected: true, feed: { ...emptyFeed, running: true } })).toBe('running')
  expect(statusOf({ ...emptyChat, connected: true, feed: { ...emptyFeed, running: true, waiting: true } })).toBe('input')
})

test('the user message goes into the feed as one block with its images', () => {
  const feed = withUserMessage(emptyFeed, [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }], 0)
  expect(feed.blocks).toEqual([{ type: 'text', role: 'user', text: 'Look', images: [{ mimeType: 'image/png', data: 'AAA' }] }])
})

test('after a prompt the next queued message is taken while connected', () => {
  const first = [{ type: 'text' as const, text: 'one' }]
  const second = [{ type: 'text' as const, text: 'two' }]
  const { state, next } = afterPrompt({ ...emptyChat, connected: true, sending: true, queue: [first, second] })
  expect(next).toEqual(first)
  expect(state.queue).toEqual([second])
  expect(state.sending).toBe(false)
})

test('a disconnected chat keeps its queue for later', () => {
  const queued = [[{ type: 'text' as const, text: 'one' }]]
  const { state, next } = afterPrompt({ ...emptyChat, connected: false, sending: true, queue: queued })
  expect(next).toBeNull()
  expect(state.queue).toEqual(queued)
  expect(state.sending).toBe(false)
})
