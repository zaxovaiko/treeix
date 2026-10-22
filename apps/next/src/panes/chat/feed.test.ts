import { expect, test } from 'bun:test'
import type { ChatEvent, ToolCallPatch } from '../../ipc/api'
import { type Block, diffCounts, emptyFeed, fileTarget, findTool, reduce, turnChanges, turnsOf } from './feed'

const NO_PATCH: ToolCallPatch = { title: null, kind: null, status: null, output: null, locations: null, rawInput: null }
const run = (events: ChatEvent[]) => events.reduce((feed, event, index) => reduce(feed, event, index * 1000), emptyFeed)

test('chunks of one role merge into one block, a new role starts another', () => {
  const feed = run([
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'Fix ' }, parent: null },
    { type: 'message_chunk', role: 'user', content: { type: 'text', text: 'it' }, parent: null },
    { type: 'turn_start' },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'On it' }, parent: null }
  ])
  expect(feed.blocks.map((block) => (block.type === 'text' ? `${block.role}:${block.text}` : block.type))).toEqual(['user:Fix it', 'agent:On it'])
  expect(feed.running).toBe(true)
})

test('thoughts time themselves and close when something else arrives', () => {
  const feed = run([
    { type: 'turn_start' },
    { type: 'thought_chunk', text: 'Hmm ', parent: null },
    { type: 'thought_chunk', text: 'yes', parent: null },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Done' }, parent: null }
  ])
  expect(feed.blocks[0]).toEqual({ type: 'thought', text: 'Hmm yes', startedAt: 1000, endedAt: 3000 })
})

test('tool calls upsert by id and permissions attach to their call', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call, parent: null },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }] }
  ])
  expect(feed.waiting).toBe(true)
  expect(feed.blocks).toHaveLength(1)
  const settled = [
    { type: 'permission_settled', requestId: 'r1' },
    { type: 'tool_call_update', id: 't1', patch: { ...NO_PATCH, status: 'completed', output: [{ type: 'text', text: '4 pass' }] } }
  ] satisfies ChatEvent[]
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
    { type: 'turn_end', stopReason: 'end_turn', usage: { input: 10, cacheRead: 40000, cacheWrite: 2000, output: 500, thought: 0 } },
    { type: 'turn_start' },
    { type: 'turn_end', stopReason: 'cancelled', usage: null }
  ])
  expect(feed).toMatchObject({
    usage: { used: 48000, size: 200000 },
    turnUsage: { cacheRead: 40000 },
    plan: [{ content: 'Read' }],
    commands: [{ name: 'compact' }],
    running: false
  })
})

test('errors become blocks and stop the turn', () => {
  expect(run([{ type: 'turn_start' }, { type: 'error', message: 'Not signed in' }])).toMatchObject({ running: false, blocks: [{ type: 'error', message: 'Not signed in' }] })
})

test('disconnected clears pending permissions, stops running and waiting, and adds an error block', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call, parent: null },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [] },
    { type: 'disconnected', message: 'Agent process exited' }
  ])
  expect(feed.running).toBe(false)
  expect(feed.waiting).toBe(false)
  expect(feed.blocks.find((block) => block.type === 'tool')).toMatchObject({ permission: null })
  expect(feed.blocks[feed.blocks.length - 1]).toEqual({ type: 'error', message: 'Agent process exited' })
})

test('diff counts lines only on one side', () => {
  expect(diffCounts(null, 'a\nb')).toEqual({ added: 2, removed: 0 })
  expect(diffCounts('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 })
  expect(diffCounts('a\na', 'a')).toEqual({ added: 0, removed: 1 })
  expect(diffCounts(null, 'a\n')).toEqual({ added: 1, removed: 0 })
  expect(diffCounts('', 'a')).toEqual({ added: 1, removed: 0 })
})

test('a file inside the folder opens relative to it, one outside from its own folder', () => {
  expect(fileTarget('/repo', '/repo/src/a.ts')).toEqual({ root: '/repo', path: 'src/a.ts' })
  expect(fileTarget('/repo', '/etc/hosts')).toEqual({ root: '/etc', path: 'hosts' })
  expect(fileTarget('/repo', 'src/a.ts')).toEqual({ root: '/repo', path: 'src/a.ts' })
})

test('a repeated tool call replaces its card instead of adding one, keeping its permission', () => {
  const call = { id: 't1', title: 'Run bun test', kind: 'execute' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} }
  const events = [
    { type: 'tool_call', call, parent: null },
    { type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow', kind: 'allow_once' }] },
    { type: 'tool_call', call: { ...call, status: 'in_progress' }, parent: null }
  ] satisfies ChatEvent[]
  const feed = events.reduce((current, event) => reduce(current, event, 0), emptyFeed)
  expect(feed.blocks).toHaveLength(1)
  expect(feed.blocks[0]).toMatchObject({ type: 'tool', call: { id: 't1', status: 'in_progress' }, permission: { requestId: 'r1' } })
})

test("a subagent's text and tool calls fold under the call that started it", () => {
  const call = (id: string, title: string) => ({ id, title, kind: 'other' as const, status: 'pending' as const, output: [], locations: [], rawInput: {} })
  const feed = run([
    { type: 'turn_start' },
    { type: 'tool_call', call: call('agent1', 'Explore the repo'), parent: null },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Looking' }, parent: 'agent1' },
    { type: 'tool_call', call: call('grep1', 'grep deposit'), parent: 'agent1' },
    { type: 'tool_call_update', id: 'grep1', patch: { ...NO_PATCH, status: 'completed' } },
    { type: 'tool_call', call: call('orphan', 'Read a.ts'), parent: 'unknown' },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Found it' }, parent: null }
  ])
  expect(feed.blocks.map((block) => (block.type === 'tool' ? block.call.id : block.type))).toEqual(['agent1', 'orphan', 'text'])
  const parent = feed.blocks[0]
  if (parent.type !== 'tool') throw new Error('expected the Agent call')
  expect(parent.children).toMatchObject([
    { type: 'text', text: 'Looking' },
    { type: 'tool', call: { id: 'grep1', status: 'completed' } }
  ])
  expect(findTool(feed.blocks, 'grep1')?.call.status).toBe('completed')
  expect(findTool(feed.blocks, 'missing')).toBeNull()
})

test('a turn splits at its last tool call or thought: the steps before, the reply after', () => {
  const text = (role: 'user' | 'agent', value: string): Block => ({ type: 'text', role, text: value, images: [] })
  const tool: Block = {
    type: 'tool',
    call: { id: 'a', title: 'Read', kind: 'read', status: 'completed', locations: [], output: [], rawInput: null },
    permission: null,
    children: []
  }
  const shape = (blocks: Block[]) => turnsOf(blocks).map(({ steps, answer }) => [steps.map((block) => block.type), answer.map((block) => block.type)])
  expect(
    shape([text('user', 'Fix it'), text('agent', 'Looking'), tool, text('agent', 'Done'), { type: 'error', message: 'x' }, text('user', 'Thanks'), text('agent', 'Sure')])
  ).toEqual([
    [[], ['text']],
    [
      ['text', 'tool'],
      ['text', 'error']
    ],
    [[], ['text']],
    [[], ['text']]
  ])
  expect(turnsOf([])).toEqual([])
})

test("a turn sums its changes per file, a subagent's too", () => {
  const edit = (id: string, path: string, oldText: string, newText: string, children: Block[] = []): Block => ({
    type: 'tool',
    call: {
      id,
      title: 'Edit',
      kind: 'edit',
      status: 'completed',
      locations: [],
      rawInput: null,
      output: [{ type: 'diff', path, oldText, newText }]
    },
    permission: null,
    children
  })
  const blocks = [edit('1', 'a.ts', 'x\n', 'y\nz\n'), edit('2', 'b.ts', '', 'b\n', [edit('3', 'a.ts', 'y\n', '')])]
  expect(turnChanges(blocks)).toEqual([
    { path: 'a.ts', added: 2, removed: 2 },
    { path: 'b.ts', added: 1, removed: 0 }
  ])
})

test('a patch keeps the fields it leaves null', () => {
  const call = { id: 't1', title: 'Edit a.ts', kind: 'edit' as const, status: 'pending' as const, output: [{ type: 'text' as const, text: 'x' }], locations: [{ path: 'a.ts', line: 3 }], rawInput: { file: 'a.ts' } }
  const feed = run([
    { type: 'tool_call', call, parent: null },
    { type: 'tool_call_update', id: 't1', patch: { ...NO_PATCH, status: 'completed' } },
  ])
  expect(feed.blocks[0]).toMatchObject({ type: 'tool', call: { ...call, status: 'completed' } })
})

test('each prompt in the log is its own message, its chunks merged', () => {
  const user = (text: string): ChatEvent => ({ type: 'message_chunk', role: 'user', content: { type: 'text', text }, parent: null })
  const feed = run([
    { type: 'turn_start' },
    { type: 'message_chunk', role: 'user', content: { type: 'image', mimeType: 'image/png', data: 'AA' }, parent: null },
    user('First'),
    { type: 'turn_end', stopReason: 'cancelled', usage: null },
    { type: 'turn_start' },
    user('Second'),
  ])
  expect(feed.blocks).toMatchObject([
    { type: 'text', role: 'user', text: 'First', images: [{ data: 'AA' }] },
    { type: 'text', role: 'user', text: 'Second' },
  ])
  expect(feed.turnStartedAt).toBe(4000)
})
