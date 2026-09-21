import { expect, test } from 'bun:test'
import type { ChatEvent } from '@treeix/sdk'
import { emptyFeed, reduce } from './feed'

const run = (events: ChatEvent[]) => events.reduce((feed, event, index) => reduce(feed, event, index * 1000), emptyFeed)

test('chunks of one role merge into one block, a new role starts another', () => {
  const feed = run([
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'Fix ' } },
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'it' } },
    { type: 'turn_start' },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'On it' } }
  ])
  expect(feed.blocks.map((block) => (block.type === 'text' ? `${block.role}:${block.text}` : block.type))).toEqual(['user:Fix it', 'agent:On it'])
  expect(feed.running).toBe(true)
})

test('thoughts time themselves and close when something else arrives', () => {
  const feed = run([{ type: 'turn_start' }, { type: 'thought_chunk', text: 'Hmm ' }, { type: 'thought_chunk', text: 'yes' }, { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Done' } }])
  expect(feed.blocks[0]).toEqual({ type: 'thought', text: 'Hmm yes', startedAt: 1000, endedAt: 3000 })
})

test('tool calls upsert by id and permissions attach to their call', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }] }
  ])
  expect(feed.waiting).toBe(true)
  expect(feed.blocks).toHaveLength(1)
  const settled = [{ type: 'permission_settled', requestId: 'r1' }, { type: 'tool_call_update', id: 't1', patch: { status: 'completed', output: [{ type: 'text', text: '4 pass' }] } }] satisfies ChatEvent[]
  const after = settled.reduce((current, event) => reduce(current, event, 9000), feed)
  expect(after.waiting).toBe(false)
  expect(after.blocks[0]).toMatchObject({ type: 'tool', permission: null, call: { status: 'completed', output: [{ type: 'text', text: '4 pass' }] } })
})

test('a permission without a known tool call stands alone', () => {
  const feed = run([{ type: 'permission', requestId: 'r2', title: 'Switch mode?', toolCallId: null, options: [] }])
  expect(feed.blocks[0]).toMatchObject({ type: 'permission', permission: { requestId: 'r2' } })
})

test('usage, plan, options, commands and turn end', () => {
  const feed = run([
    { type: 'turn_start' },
    { type: 'usage', used: 48000, size: 200000, cost: null },
    { type: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'in_progress' }] },
    { type: 'commands', commands: [{ name: 'compact', description: '' }] },
    { type: 'turn_end', stopReason: 'end_turn' }
  ])
  expect(feed).toMatchObject({ usage: { used: 48000, size: 200000 }, plan: [{ content: 'Read' }], commands: [{ name: 'compact' }], running: false })
})

test('errors become blocks and stop the turn', () => {
  expect(run([{ type: 'turn_start' }, { type: 'error', message: 'Not signed in' }])).toMatchObject({ running: false, blocks: [{ type: 'error', message: 'Not signed in' }] })
})

test('disconnected clears pending permissions, stops running and waiting, and adds an error block', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [] },
    { type: 'disconnected', message: 'Agent process exited' }
  ])
  expect(feed.running).toBe(false)
  expect(feed.waiting).toBe(false)
  expect(feed.blocks.find((block) => block.type === 'tool')).toMatchObject({ permission: null })
  expect(feed.blocks[feed.blocks.length - 1]).toEqual({ type: 'error', message: 'Agent process exited' })
})
