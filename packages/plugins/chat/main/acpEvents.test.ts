import { expect, test } from 'bun:test'
import { fromPermissionRequest, fromSessionUpdate, optionsFrom, toPromptBlocks } from './acpEvents'

test('message and thought chunks', () => {
  expect(fromSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } })).toEqual([{ type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Hi' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix it' } })).toEqual([{ type: 'message_chunk', role: 'user', content: { type: 'text', text: 'Fix it' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } })).toEqual([{ type: 'thought_chunk', text: 'Hmm' }])
})

test('tool calls with diffs, and updates as patches', () => {
  const [call] = fromSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Edit Pricing.tsx',
    kind: 'edit',
    status: 'pending',
    content: [{ type: 'diff', path: '/repo/Pricing.tsx', oldText: 'a', newText: 'b' }],
    locations: [{ path: '/repo/Pricing.tsx', line: 3 }],
    rawInput: { file_path: '/repo/Pricing.tsx' }
  })
  expect(call).toEqual({
    type: 'tool_call',
    call: { id: 't1', title: 'Edit Pricing.tsx', kind: 'edit', status: 'pending', output: [{ type: 'diff', path: '/repo/Pricing.tsx', oldText: 'a', newText: 'b' }], locations: [{ path: '/repo/Pricing.tsx', line: 3 }], rawInput: { file_path: '/repo/Pricing.tsx' } }
  })
  expect(fromSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })).toEqual([
    { type: 'tool_call_update', id: 't1', patch: { status: 'completed', output: [{ type: 'text', text: 'ok' }] } }
  ])
})

test('plan, usage, commands, options and unknown updates', () => {
  expect(fromSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] })).toEqual([{ type: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] }])
  expect(fromSessionUpdate({ sessionUpdate: 'usage_update', used: 48000, size: 200000, cost: { amount: 0.04, currency: 'USD' } })).toEqual([{ type: 'usage', used: 48000, size: 200000, cost: { amount: 0.04, currency: 'USD' } }])
  expect(fromSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Summarize' }] })).toEqual([{ type: 'commands', commands: [{ name: 'compact', description: 'Summarize' }] }])
  expect(fromSessionUpdate({ sessionUpdate: 'something_new' })).toEqual([])
  expect(fromSessionUpdate(null)).toEqual([])
})

test('config options and legacy modes both become options', () => {
  expect(
    optionsFrom({
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet', description: 'Faster' }] }]
    })
  ).toEqual([{ id: 'model', name: 'Model', category: 'model', currentValue: 'opus', values: [{ value: 'opus', name: 'Opus', description: null }, { value: 'sonnet', name: 'Sonnet', description: 'Faster' }] }])
  expect(optionsFrom({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } })).toEqual([
    { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'ask', values: [{ value: 'ask', name: 'Ask', description: null }, { value: 'code', name: 'Code', description: null }] }
  ])
})

test('permission requests keep option order and the tool call link', () => {
  expect(
    fromPermissionRequest('r1', {
      toolCall: { toolCallId: 't1', title: 'Run bun test' },
      options: [
        { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'd', name: 'Reject', kind: 'reject_once' }
      ]
    })
  ).toEqual({ type: 'permission', requestId: 'r1', title: 'Run bun test', toolCallId: 't1', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }, { id: 'd', name: 'Reject', kind: 'reject_once' }] })
})

test('permission requests read title and tool call id from the newer subject shape', () => {
  expect(
    fromPermissionRequest('r2', {
      title: 'Delete file',
      subject: { toolCall: { toolCallId: 't2', title: 'rm old.txt' } },
      options: [{ optionId: 'a', name: 'Allow once', kind: 'allow_once' }]
    })
  ).toEqual({ type: 'permission', requestId: 'r2', title: 'Delete file', toolCallId: 't2', options: [{ id: 'a', name: 'Allow once', kind: 'allow_once' }] })
})

test('prompt blocks', () => {
  expect(toPromptBlocks([{ type: 'text', text: 'Hi' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }])).toEqual([
    { type: 'text', text: 'Hi' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' }
  ])
})
