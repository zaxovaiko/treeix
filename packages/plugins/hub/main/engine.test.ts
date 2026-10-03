import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatAdapter, ChatEvent } from '@treeix/sdk/main'
import type { Run, Workflow } from '../shared/workflow'
import { createEngine } from './engine'
import { createRuns } from './runs'

const dir = mkdtempSync(join(tmpdir(), 'hub-runs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Thinks, calls a tool, then answers `<agent>: <prompt>`; a prompt saying "hang" never answers */
const adapter: ChatAdapter = {
  id: 'fake',
  label: 'Fake',
  connect: async ({ command }) => {
    const listeners = new Set<(event: ChatEvent) => void>()
    const emit = (event: ChatEvent): void => listeners.forEach((listener) => listener(event))
    return {
      sessionId: 's',
      capabilities: { images: false, load: false, list: false },
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      prompt: async (content) => {
        const text = content[0].type === 'text' ? content[0].text : ''
        if (text.includes('hang')) return new Promise(() => undefined)
        emit({ type: 'thought_chunk', text: 'Hm' })
        emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Let me look' } })
        emit({ type: 'tool_call', call: { id: 't', title: 'Read', kind: 'read', status: 'completed', output: [], locations: [], rawInput: null } })
        for (const piece of [`${command}: `, text]) emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: piece } })
        return { stopReason: 'end_turn' }
      },
      cancel: () => undefined,
      answer: () => undefined,
      setOption: async () => undefined,
      close: () => listeners.clear()
    }
  }
}

const runs = createRuns(dir)
const updates: Run[] = []
const engine = createEngine({
  adapter: (id) => (id === 'fake' ? adapter : null),
  runtime: async (agent) => (agent === 'gone' ? null : { agent, adapter: 'fake', command: agent, cwd: '/' }),
  sessionEnv: async () => ({}),
  runs,
  onRun: (run) => updates.push(run),
  onEvents: () => undefined
})

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
  await new Promise((resolve) => setTimeout(resolve, 20))
  engine.cancel(hung.id)
  expect(await engine.wait(hung.id)).toMatchObject({ status: 'cancelled', nodes: { agent: { status: 'cancelled' } } })
  expect(updates.at(-1)).toMatchObject({ id: hung.id, status: 'cancelled' })
})
