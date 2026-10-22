import { expect, test } from 'bun:test'
import type { Api, ChatContent, ChatEntry, ChatEvent, ChatInfo, ChatsEvent } from '../../ipc/api'
import { emptyFeed } from './feed'
import { activityOf, applyEntries, cancel, emptyChat, getChat, initChats, nextQueued, retain, send, setDraft, shortTitle, storedQueues, titleOf } from './store'

const storage = new Map<string, string>()
globalThis.localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) } as unknown as Storage

const text = (value: string): ChatContent[] => [{ type: 'text', text: value }]
const entry = (seq: number, event: ChatEvent): ChatEntry => ({ seq, at: seq * 1000, event })

test('a short title is the first line, cut at 40 characters', () => {
  expect(shortTitle('  Fix the login\nmore')).toBe('Fix the login')
  expect(shortTitle('x'.repeat(50))).toBe(`${'x'.repeat(39)}…`)
  expect(shortTitle('  \n')).toBeNull()
})

test("the title is the agent's, else the first message, else ptyd's", () => {
  const user = { type: 'text' as const, role: 'user' as const, text: '<bash-input>git status</bash-input>\n<bash-stdout></bash-stdout><bash-stderr></bash-stderr>', images: [] }
  expect(titleOf(emptyChat)).toBe('New chat')
  expect(titleOf({ ...emptyChat, feed: { ...emptyFeed, blocks: [user] } })).toBe('git status')
  expect(titleOf({ ...emptyChat, feed: { ...emptyFeed, blocks: [user], title: 'Status check' } })).toBe('Status check')
})

test('activity follows the newest block', () => {
  const running = { ...emptyChat, feed: { ...emptyFeed, running: true } }
  expect(activityOf({ ...emptyChat, sending: true })).toBe('Sending')
  expect(activityOf(running)).toBe('Working')
  expect(activityOf({ ...running, feed: { ...running.feed, blocks: [{ type: 'thought', text: '', startedAt: 0, endedAt: null }] } })).toBe('Thinking')
  expect(activityOf({ ...running, feed: { ...running.feed, blocks: [{ type: 'text', role: 'agent', text: 'Hi', images: [] }] } })).toBe('Writing')
})

test('entries apply once, in seq order, and turn_start ends sending', () => {
  const once = applyEntries({ ...emptyChat, sending: true }, [entry(0, { type: 'turn_start' }), entry(1, { type: 'title', title: 'A' })])
  expect(once).toMatchObject({ seq: 2, sending: false, feed: { running: true, title: 'A' } })
  expect(applyEntries(once, [entry(1, { type: 'title', title: 'B' })])).toBe(once)
})

test('a queued message waits for the turn, the permission and the agent', () => {
  const queued = { ...emptyChat, queue: [text('next')] }
  expect(nextQueued(queued)).toEqual(text('next'))
  expect(nextQueued({ ...queued, feed: { ...emptyFeed, running: true } })).toBeNull()
  expect(nextQueued({ ...queued, feed: { ...emptyFeed, waiting: true } })).toBeNull()
  expect(nextQueued({ ...queued, info: { status: 'disconnected' } as ChatInfo })).toBeNull()
})

/** A ptyd that logs prompts and lets the test end turns */
function fakeApi() {
  const log: ChatEntry[] = []
  const streams = new Set<(entry: ChatEntry) => void>()
  const prompts: ChatContent[][] = []
  const push = (event: ChatEvent) => {
    const logged = entry(log.length, event)
    log.push(logged)
    streams.forEach((stream) => stream(logged))
  }
  const info = { id: 'c1', status: 'idle' } as ChatInfo
  const api = {
    onChats: (_: (e: ChatsEvent) => void) => () => undefined,
    chatList: async () => [info],
    async chatAttach(_: string, from: number, onEntry: (entry: ChatEntry) => void) {
      log.slice(from).forEach(onEntry)
      streams.add(onEntry)
      return { info, detach: async () => void streams.delete(onEntry) }
    },
    async chatPrompt(_: string, content: ChatContent[]) {
      prompts.push(content)
      push({ type: 'turn_start' })
      content.forEach((c) => push({ type: 'message_chunk', role: 'user', content: c, parent: null }))
    },
    async chatCancel() {
      push({ type: 'turn_end', stopReason: 'cancelled', usage: null })
    },
  } as unknown as Api
  return { api, push, prompts, streams }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('messages sent during a turn queue, persist, and go out one per turn; cancel puts them back in the draft', async () => {
  const fake = fakeApi()
  initChats(fake.api)
  const release = retain('c1')
  await tick()
  send('c1', text('one'))
  await tick()
  expect(getChat('c1').feed.running).toBe(true)
  send('c1', text('two'))
  send('c1', text('three'))
  expect(getChat('c1').queue).toEqual([text('two'), text('three')])
  expect(storedQueues()).toEqual({ c1: [text('two'), text('three')] })

  fake.push({ type: 'turn_end', stopReason: 'end_turn', usage: null })
  await tick()
  expect(fake.prompts).toEqual([text('one'), text('two')])
  expect(getChat('c1').queue).toEqual([text('three')])

  setDraft('c1', 'draft')
  cancel('c1')
  await tick()
  expect(getChat('c1')).toMatchObject({ queue: [], draft: 'three\n\ndraft' })
  expect(storedQueues()).toEqual({})
  expect(getChat('c1').feed.blocks.filter((block) => block.type === 'text').map((block) => block.type === 'text' && block.text)).toEqual(['one', 'two'])

  // Detached, then attached again: only what is new replays
  release()
  expect(fake.streams.size).toBe(0)
  fake.push({ type: 'title', title: 'Later' })
  retain('c1')
  await tick()
  expect(getChat('c1').feed.title).toBe('Later')
  expect(getChat('c1').feed.blocks.filter((block) => block.type === 'text')).toHaveLength(2)
})
