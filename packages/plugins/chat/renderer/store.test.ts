import { expect, test } from 'bun:test'
import { emptyFeed } from './feed'
import type { StartResult } from '../shared/types'
import { afterPrompt, cancel, emptyChat, getChat, listen, send, setDraft, start, statusOf, subscribe, whenIdle, withUserMessage } from './store'

test('status: waiting beats running beats connected', () => {
  expect(statusOf(emptyChat)).toBe('exited')
  expect(statusOf({ ...emptyChat, connected: true })).toBe('idle')
  expect(statusOf({ ...emptyChat, connected: true, sending: true })).toBe('running')
  expect(statusOf({ ...emptyChat, connected: true, feed: { ...emptyFeed, running: true } })).toBe('running')
  expect(statusOf({ ...emptyChat, connected: true, feed: { ...emptyFeed, running: true, waiting: true } })).toBe('input')
})

test('the user message goes into the feed as one block with its images', () => {
  const feed = withUserMessage(emptyFeed, [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }])
  expect(feed.blocks).toEqual([{ type: 'text', role: 'user', text: 'Look', images: [{ mimeType: 'image/png', data: 'AAA' }] }])
})

test('after a prompt the next queued message starts right away while connected', () => {
  const first = [{ type: 'text' as const, text: 'one' }]
  const second = [{ type: 'text' as const, text: 'two' }]
  const { state, next } = afterPrompt({ ...emptyChat, connected: true, sending: true, queue: [first, second] })
  expect(next).toEqual(first)
  expect(state.queue).toEqual([second])
  expect(state.sending).toBe(true)
  expect(state.feed.blocks).toEqual([{ type: 'text', role: 'user', text: 'one', images: [] }])
})

test('a disconnected chat keeps its queue for later', () => {
  const queued = [[{ type: 'text' as const, text: 'one' }]]
  const { state, next } = afterPrompt({ ...emptyChat, connected: false, sending: true, queue: queued })
  expect(next).toBeNull()
  expect(state.queue).toEqual(queued)
  expect(state.sending).toBe(false)
})

test('consecutive user messages stay separate blocks', () => {
  const once = withUserMessage(emptyFeed, [{ type: 'text', text: 'one' }])
  const twice = withUserMessage(once, [{ type: 'text', text: 'two' }])
  expect(twice.blocks.map((block) => (block.type === 'text' ? block.text : block.type))).toEqual(['one', 'two'])
})

type Pending = { content: unknown; done: () => void }
const prompts: Pending[] = []
const sent: unknown[][] = []
const handlers = new Map<string, (...args: unknown[]) => void>()
const startResult: StartResult = { agentSessionId: 'session', capabilities: { images: false, load: false, list: false }, terminalCommand: null }

listen({
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> =>
    new Promise<unknown>((resolve) => {
      if (channel === 'start') resolve(startResult)
      else if (channel === 'prompt') prompts.push({ content: args[1], done: () => resolve({ stopReason: 'end_turn' }) })
      else resolve(undefined)
    }) as Promise<T>,
  send: (...args) => void sent.push(args),
  on: (channel, listener) => {
    handlers.set(channel, listener)
    return () => handlers.delete(channel)
  }
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const text = (value: string) => [{ type: 'text' as const, text: value }]

test('a queued message starts in the same update the turn before it ends, so whenIdle waits for it', async () => {
  await start('queue', { agent: 'claude', adapter: 'acp', command: 'x', cwd: '/repo', resume: null })
  prompts.length = 0
  send('queue', text('/compact'))
  send('queue', text('after'))
  expect(getChat('queue').queue).toEqual([text('after')])
  let idle = false
  void whenIdle('queue').then(() => (idle = true))
  const statuses: string[] = []
  const unsubscribe = subscribe(() => statuses.push(statusOf(getChat('queue'))))
  prompts[0]?.done()
  await flush()
  expect(prompts.map((prompt) => prompt.content)).toEqual([text('/compact'), text('after')])
  expect(statuses).not.toContain('idle')
  expect(idle).toBe(false)
  prompts[1]?.done()
  await flush()
  expect(idle).toBe(true)
  unsubscribe()
})

test('stopping empties the queue back into the draft', async () => {
  await start('stop', { agent: 'claude', adapter: 'acp', command: 'x', cwd: '/repo', resume: null })
  send('stop', text('first'))
  send('stop', text('second'))
  send('stop', text('third'))
  setDraft('stop', 'typing')
  cancel('stop')
  expect(sent).toContainEqual(['cancel', 'stop'])
  expect(getChat('stop').queue).toEqual([])
  expect(getChat('stop').draft).toBe('second\n\nthird\n\ntyping')
})

test('event payloads that are not chat events are ignored', () => {
  handlers.get('events')?.('events-chat', [{ nope: 1 }])
  expect(getChat('events-chat').feed).toBe(emptyFeed)
  handlers.get('events')?.('events-chat', [{ type: 'turn_start' }])
  expect(getChat('events-chat').feed.running).toBe(true)
})
