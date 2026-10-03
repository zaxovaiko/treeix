import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatAdapter, ChatEvent } from '@treeix/sdk/main'
import type { Run, Workflow } from '../shared/workflow'
import { createEngine } from './engine'
import { createRuns } from './runs'

const dir = mkdtempSync(join(tmpdir(), 'hub-runs-'))

/** Thinks, calls a tool, then answers `<agent>: <prompt>`; a prompt saying "hang" never answers, one saying "permission" answers with the option picked */
const adapter: ChatAdapter = {
  id: 'fake',
  label: 'Fake',
  connect: async ({ command }) => {
    const listeners = new Set<(event: ChatEvent) => void>()
    const emit = (event: ChatEvent): void => listeners.forEach((listener) => listener(event))
    let picked: (optionId: string | null) => void = () => undefined
    return {
      sessionId: 's',
      capabilities: { images: false, load: false, list: false },
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      prompt: async (content) => {
        const text = content[0].type === 'text' ? content[0].text : ''
        if (text.includes('hang')) return new Promise(() => undefined)
        if (text.includes('permission')) {
          const answer = new Promise<string | null>((resolve) => (picked = resolve))
          emit({ type: 'permission', requestId: 'r', title: 'Edit', toolCallId: 't', options: [{ id: 'no', name: 'No', kind: 'reject_once' }, { id: 'yes', name: 'Yes', kind: 'allow_once' }] })
          const optionId = await answer
          emit({ type: 'permission_settled', requestId: 'r' })
          emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: `${command}: ${optionId}` } })
          return { stopReason: 'end_turn' }
        }
        emit({ type: 'thought_chunk', text: 'Hm' })
        emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Let me look' } })
        emit({ type: 'tool_call', call: { id: 't', title: 'Read', kind: 'read', status: 'completed', output: [], locations: [], rawInput: null } })
        for (const piece of [`${command}: `, text]) emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: piece } })
        return { stopReason: 'end_turn' }
      },
      cancel: () => undefined,
      answer: (_, optionId) => picked(optionId),
      setOption: async () => undefined,
      close: () => listeners.clear()
    }
  }
}

const runs = createRuns(dir)
// Waits out the last writes first
afterAll(async () => {
  await runs.list()
  rmSync(dir, { recursive: true, force: true })
})
const updates: Run[] = []
let flakyIsBack = false
const engineOver = (store: typeof runs) =>
  createEngine({
    adapter: (id) => (id === 'fake' ? adapter : null),
    runtime: async (agent) => (agent === 'gone' || (agent === 'flaky' && !flakyIsBack) ? null : { agent, adapter: 'fake', command: agent, cwd: '/' }),
    autoApprove: async (agent) => agent === 'trusty',
    sessionEnv: async () => ({}),
    runs: store,
    onRun: (run) => updates.push(run),
    onEvents: () => undefined
  })
const engine = engineOver(runs)
const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20))

const agentNode = (id: string, prompt: string) => ({ id, kind: 'agent' as const, agent: id, prompt, folder: null, retries: 0, onError: 'stop' as const, timeoutMin: 1 })

test('fans out to two agents, merges their answers and keeps the run on disk', async () => {
  const workflow: Workflow = {
    id: 'w',
    name: 'Review',
    updatedAt: 0,
    layout: {},
    nodes: [
      { id: 'input', kind: 'input' },
      agentNode('security', 'Check {{input}}'),
      agentNode('style', 'Style of {{input}}'),
      { id: 'merge', kind: 'merge', template: '{{nodes.security.output}} | {{nodes.style.output}}' },
      { id: 'output', kind: 'output', template: 'Done: {{prev}}' }
    ],
    edges: [
      { id: '1', from: 'input', to: 'security', branch: null },
      { id: '2', from: 'input', to: 'style', branch: null },
      { id: '3', from: 'security', to: 'merge', branch: null },
      { id: '4', from: 'style', to: 'merge', branch: null },
      { id: '5', from: 'merge', to: 'output', branch: null }
    ]
  }
  const started = engine.launch('workflow', 'Review', workflow, 'the diff')
  const run = await engine.wait(started.id)
  expect(run?.status).toBe('done')
  expect(run?.output).toBe('Done: security: Check the diff | style: Style of the diff')
  expect(run?.nodes.security).toMatchObject({ status: 'done', prompt: 'Check the diff', attempt: 1 })

  const stored = await runs.list()
  expect(stored[0]).toMatchObject({ id: started.id, status: 'done' })
  const events = (await engine.events(started.id)).filter((entry) => entry.node === 'style').map((entry) => entry.event.type)
  // The prompt shows as the user's message, and streamed pieces are joined
  expect(events).toEqual(['message_chunk', 'thought_chunk', 'message_chunk', 'tool_call', 'message_chunk'])
})

test('an ask fails with the reason when its agent is gone, and a cancel ends a hung agent', async () => {
  const failed = await engine.wait(engine.ask('gone', 'Hi', null, false).id)
  expect(failed).toMatchObject({ status: 'failed', title: 'Hi', output: null, nodes: { agent: { status: 'failed', error: 'The agent is gone, or its runtime is' } } })

  const hung = engine.ask('scout', 'please hang', null, true)
  await tick()
  engine.cancel(hung.id)
  expect(await engine.wait(hung.id)).toMatchObject({ status: 'cancelled', nodes: { agent: { status: 'cancelled' } } })
  expect(updates.at(-1)).toMatchObject({ id: hung.id, status: 'cancelled' })
})

const gated = (middle: Workflow['nodes'][number]): Workflow => ({
  id: 'g',
  name: 'Gated',
  updatedAt: 0,
  layout: {},
  nodes: [{ id: 'input', kind: 'input' }, middle, { id: 'output', kind: 'output', template: 'Shipped {{prev}}' }],
  edges: [
    { id: '1', from: 'input', to: middle.id, branch: null },
    { id: '2', from: middle.id, to: 'output', branch: null }
  ]
})
const approval = gated({ id: 'gate', kind: 'approval', message: 'Ship {{input}}?' })

test('an approval holds the run until approved, passing its input on, and a reject fails it', async () => {
  const approved = engine.launch('workflow', 'Gated', approval, 'v2')
  await tick()
  expect(updates.at(-1)?.nodes.gate).toMatchObject({ status: 'running', waiting: 'approval', prompt: 'Ship v2?' })
  engine.decide(approved.id, 'gate', true)
  expect(await engine.wait(approved.id)).toMatchObject({ status: 'done', output: 'Shipped v2', nodes: { gate: { status: 'done', waiting: null } } })

  const rejected = engine.launch('workflow', 'Gated', approval, 'v3')
  engine.decide(rejected.id, 'gate', false)
  expect(await engine.wait(rejected.id)).toMatchObject({ status: 'failed', output: null, nodes: { gate: { error: 'Rejected' }, output: { status: 'pending' } } })
})

test('an approval waits on across a relaunch, while a run cut short by it is interrupted', async () => {
  const store = createRuns(join(dir, 'relaunch'))
  const before = engineOver(store)
  const waiting = before.launch('workflow', 'Gated', approval, 'v4')
  const hung = before.ask('scout', 'hang', null, false)
  await tick()
  before.dispose()

  const after = engineOver(store)
  await after.recover()
  expect((await after.list()).map((run) => [run.id, run.status])).toEqual(
    expect.arrayContaining([
      [waiting.id, 'running'],
      [hung.id, 'interrupted']
    ])
  )
  after.decide(waiting.id, 'gate', true)
  expect(await after.wait(waiting.id)).toMatchObject({ status: 'done', output: 'Shipped v4' })
})

test('permissions wait for an answer, unless the agent allows everything', async () => {
  expect(await engine.wait(engine.ask('trusty', 'permission please', null, false).id)).toMatchObject({ status: 'done', output: 'trusty: yes' })

  const asked = engine.ask('scout', 'permission please', null, false)
  await tick()
  expect(updates.at(-1)?.nodes.agent.waiting).toBe('permission')
  engine.answer(asked.id, 'agent', 'r', 'no')
  expect(await engine.wait(asked.id)).toMatchObject({ status: 'done', output: 'scout: no', nodes: { agent: { waiting: null } } })
})

test('retrying a failed step runs it and what follows again', async () => {
  const failed = await engine.wait(engine.launch('workflow', 'Gated', gated(agentNode('flaky', 'Build {{input}}')), 'v5').id)
  expect(failed).toMatchObject({ status: 'failed', nodes: { output: { status: 'pending' } } })
  flakyIsBack = true
  await engine.retry(failed?.id ?? '', 'flaky')
  expect(await engine.wait(failed?.id ?? '')).toMatchObject({ status: 'done', output: 'Shipped flaky: Build v5', nodes: { flaky: { attempt: 1 } } })
})
