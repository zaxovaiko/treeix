import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatAdapter, ChatEvent } from '@treeix/sdk/main'
import { DECISION_DEFAULTS, type DecisionSettings } from '../shared/types'
import type { Run, Workflow } from '../shared/workflow'
import { createDecisions } from './decisions'
import { createEngine, parseReview } from './engine'
import { createRuns } from './runs'

const dir = mkdtempSync(join(tmpdir(), 'hub-runs-'))

/** Each connection's `resume`, in order */
const resumed: (string | null)[] = []

/**
 * Thinks, calls a tool, then answers `<agent>: <prompt>`; a prompt saying "hang" never answers, one saying "permission" answers with the option picked,
 * and one asking for a decision approves, unless the agent is the naysayer
 */
const adapter: ChatAdapter = {
  id: 'fake',
  label: 'Fake',
  connect: async ({ command, resume }) => {
    resumed.push(resume ?? null)
    const listeners = new Set<(event: ChatEvent) => void>()
    const emit = (event: ChatEvent): void => listeners.forEach((listener) => listener(event))
    let picked: (optionId: string | null) => void = () => undefined
    return {
      sessionId: 's',
      capabilities: { images: false, load: false, list: false },
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      prompt: async (content) => {
        const text = content[0].type === 'text' ? content[0].text : ''
        if (text.includes('You decide in place')) {
          emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: `{"approve": ${command !== 'naysayer'}, "reason": "${command} checked it"}` } })
          return { stopReason: 'end_turn' }
        }
        if (text.includes("You review another agent's work")) {
          // The critic passes work that was sent back once; the harsh one never does
          const score = command === 'garbled' ? null : command === 'critic' && text.includes('A reviewer scored') ? 9 : 3
          const reply = score === null ? 'Looks fine to me' : JSON.stringify({ score, issues: score < 8 ? ['add a test', 7] : [] })
          emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: reply } })
          return { stopReason: 'end_turn' }
        }
        if (/\bhang\b/.test(text)) return new Promise(() => undefined)
        if (text.includes('permission')) {
          const answer = new Promise<string | null>((resolve) => (picked = resolve))
          emit({
            type: 'permission',
            requestId: 'r',
            title: 'Edit',
            toolCallId: 't',
            options: [
              { id: 'no', name: 'No', kind: 'reject_once' },
              { id: 'yes', name: 'Yes', kind: 'allow_once' }
            ]
          })
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
let notionIsUp = false
const toolCalls: [string, Record<string, unknown>][] = []
const engineOver = (store: typeof runs) =>
  createEngine({
    adapter: (id) => (id === 'fake' ? adapter : null),
    runtime: async (agent) => (agent === 'gone' || (agent === 'flaky' && !flakyIsBack) ? null : { agent, adapter: 'fake', command: agent, cwd: '/' }),
    autoApprove: async (agent) => agent === 'trusty',
    sessionEnv: async () => ({}),
    callTool: async (name, args) => {
      toolCalls.push([name, args])
      if (name === 'notion_create_pages' && !notionIsUp) throw new Error('Notion is down')
      return `${name} ok`
    },
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

test("the user's changes on an approval send its step back to redo the work, and notes on approve go on with it", async () => {
  const planned: Workflow = {
    id: 'p',
    name: 'Planned',
    updatedAt: 0,
    layout: {},
    nodes: [
      { id: 'input', kind: 'input' },
      agentNode('planner', 'Plan {{input}}'),
      { id: 'gate', kind: 'approval', message: 'Plan: {{prev}}', retryStep: 'planner' },
      { id: 'output', kind: 'output', template: '{{prev}}' }
    ],
    edges: [
      { id: '1', from: 'input', to: 'planner', branch: null },
      { id: '2', from: 'planner', to: 'gate', branch: null },
      { id: '3', from: 'gate', to: 'output', branch: null }
    ]
  }
  const latest = (id: string): Run | undefined => updates.findLast((update) => update.id === id)
  resumed.length = 0
  const run = engine.launch('workflow', 'Planned', planned, 'the login')
  const waiting = async (): Promise<void> => {
    while (latest(run.id)?.nodes.gate.waiting !== 'approval') await tick()
  }
  await waiting()
  engine.decide(run.id, 'gate', false, { by: 'you', via: 'jira', reason: 'Use OAuth' })
  await tick()
  expect(latest(run.id)?.nodes.gate.decision).toMatchObject({ approved: false, reason: 'Use OAuth' })
  await waiting()
  expect(latest(run.id)?.nodes.planner.prompt).toStartWith('The user read your work and wants changes before the run goes on:\n\nUse OAuth')
  engine.decide(run.id, 'gate', true, { by: 'you', via: 'app', reason: 'Keep it small' })
  const done = await engine.wait(run.id)
  expect(done).toMatchObject({ status: 'done', nodes: { gate: { status: 'done' } } })
  expect(done?.output).toEndWith('Notes from the approval: Keep it small')
  // Planner, then the planner again in its own conversation
  expect(resumed).toEqual([null, 's'])

  // Without changes, or decided by an agent, a reject still fails the run
  const plain = engine.launch('workflow', 'Planned', planned, 'the logout')
  while (latest(plain.id)?.nodes.gate.waiting !== 'approval') await tick()
  engine.decide(plain.id, 'gate', false, { by: 'agent', via: 'app', reason: 'Too risky' })
  expect(await engine.wait(plain.id)).toMatchObject({ status: 'failed', nodes: { gate: { error: 'Rejected' } } })
})

test('an approval waits on across a relaunch, while a run cut short by it is interrupted', async () => {
  const store = createRuns(join(dir, 'relaunch'))
  const before = engineOver(store)
  const waiting = before.launch('workflow', 'Gated', approval, 'v4')
  const hung = before.ask('scout', 'hang', null, false)
  await tick()
  expect(before.dispose()).toEqual([hung.id])

  const after = engineOver(store)
  expect(await after.recover()).toEqual([])
  expect((await after.list()).map((run) => [run.id, run.status])).toEqual(
    expect.arrayContaining([
      [waiting.id, 'running'],
      [hung.id, 'interrupted']
    ])
  )
  after.decide(waiting.id, 'gate', true)
  expect(await after.wait(waiting.id)).toMatchObject({ status: 'done', output: 'Shipped v4' })
})

test('resuming an interrupted run picks the cut-short agent back up in its conversation', async () => {
  const store = createRuns(join(dir, 'resume'))
  const before = engineOver(store)
  const hung = before.ask('scout', 'hang', null, false)
  await tick()
  before.dispose()

  const after = engineOver(store)
  await after.recover()
  resumed.length = 0
  await after.resume(hung.id)
  await tick()
  expect(resumed).toEqual(['s'])
  expect((await after.list()).find((run) => run.id === hung.id)?.nodes.agent).toMatchObject({ status: 'running', prompt: expect.stringContaining('Continue where you stopped') })
  after.cancel(hung.id)
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

test('a tool step gets its arguments from earlier outputs, fails the run when the call fails, and a retry calls only what failed', async () => {
  const workflow = gated({ id: 'save', kind: 'tool', tool: 'notion_create_pages', args: '{"pages":"{{input.tasks}}","title":"From {{input.title}}"}' })
  const input = JSON.stringify({ title: 'Daily', tasks: [{ Name: 'Ship it' }] })
  const failed = await engine.wait(engine.launch('workflow', 'Daily', workflow, input).id)
  expect(failed).toMatchObject({ status: 'failed', nodes: { save: { status: 'failed', error: 'Notion is down' }, output: { status: 'pending' } } })
  expect(toolCalls.at(-1)).toEqual(['notion_create_pages', { pages: [{ Name: 'Ship it' }], title: 'From Daily' }])

  notionIsUp = true
  await engine.retry(failed?.id ?? '', 'save')
  expect(await engine.wait(failed?.id ?? '')).toMatchObject({ status: 'done', output: 'Shipped notion_create_pages ok' })
  expect(toolCalls).toHaveLength(2)
})

/** An engine with decisions on it, and a ticket whose comments live in memory */
function decided(settings: Partial<DecisionSettings>) {
  const comments: { created: string; body: string }[] = []
  const told: string[] = []
  const store = createRuns(join(dir, `decisions-${Math.random()}`))
  let decisions: ReturnType<typeof createDecisions> | null = null
  const engine = createEngine({
    adapter: () => adapter,
    runtime: async (agent) => ({ agent, adapter: 'fake', command: agent, cwd: '/' }),
    autoApprove: async () => false,
    sessionEnv: async () => ({}),
    callTool: async () => '',
    runs: store,
    onRun: (run) => decisions?.watch(run),
    onEvents: () => undefined
  })
  decisions = createDecisions({
    engine,
    settings: async () => ({ ...DECISION_DEFAULTS, ...settings }),
    callTool: async (name, args) => {
      if (name === 'jira_work_item') return JSON.stringify({ comments })
      comments.push({ created: new Date(Date.now() + comments.length).toISOString(), body: String(args.body) })
      return 'Commented'
    },
    notify: (_, title, body) => told.push(`${title}: ${body}`)
  })
  return { engine, decisions, comments, told }
}

/** An agent's work, then an approval on it that gives up after `timeoutMin` */
const fedGate = (agent: string, timeoutMin: number | null): Workflow => ({
  ...gated({ id: 'gate', kind: 'approval', message: 'Ship {{input}}?', timeoutMin }),
  nodes: [
    { id: 'input', kind: 'input' },
    agentNode(agent, 'Build {{input}}'),
    { id: 'gate', kind: 'approval', message: 'Ship {{input}}?', timeoutMin },
    { id: 'output', kind: 'output', template: 'Shipped {{prev}}' }
  ],
  edges: [
    { id: '1', from: 'input', to: agent, branch: null },
    { id: '2', from: agent, to: 'gate', branch: null },
    { id: '3', from: 'gate', to: 'output', branch: null }
  ]
})

test('nobody answers an approval in time: the agent feeding it decides, and its decision is recorded and told', async () => {
  const { engine, told } = decided({ afterMin: 60 })
  const run = await engine.wait(engine.launch('workflow', 'Quick', fedGate('judge', 0.001), 'v6').id)
  expect(run).toMatchObject({ status: 'done', output: 'Shipped judge: Build v6', nodes: { gate: { decision: { approved: true, by: 'agent', reason: 'judge checked it' } } } })
  await tick()
  expect(told).toEqual(['Quick: approved: Approved by an agent, as nobody replied in time: judge checked it'])

  const { engine: strict } = decided({ afterMin: 0.001 })
  expect(await strict.wait(strict.launch('workflow', 'Strict', fedGate('naysayer', null), 'v7').id)).toMatchObject({
    status: 'failed',
    nodes: { gate: { error: 'Rejected', decision: { approved: false, by: 'agent', reason: 'naysayer checked it' } } }
  })
})

test('a permission nobody answers is decided by the asking agent, and with no deadline set the step waits on', async () => {
  const { engine } = decided({ afterMin: 0.001 })
  expect(await engine.wait(engine.ask('scout', 'permission please', null, false).id)).toMatchObject({
    status: 'done',
    output: 'scout: yes',
    nodes: { agent: { decision: { approved: true, by: 'agent', via: 'app' } } }
  })

  const { engine: patient } = decided({ afterMin: null })
  const waiting = patient.ask('scout', 'permission please', null, false)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect((await patient.list()).find((run) => run.id === waiting.id)?.nodes.agent.waiting).toBe('permission')
  patient.cancel(waiting.id)
})

test('a reply on the ticket decides: Treeix asks once, takes the first approve or reject under its question, and posts what was decided', async () => {
  const { engine, decisions, comments, told } = decided({ afterMin: null })
  const run = engine.launch('workflow', 'Ticketed', approval, 'v8', false, { ticket: { key: 'BF-1', url: null } })
  await decisions.ask(run, 'gate')
  await decisions.ask(run, 'gate')
  expect(comments).toHaveLength(1)
  expect(comments[0].body).toContain(`[treeix:${run.id}:gate] on Ticketed: Ship v8?`)

  comments.push(
    { created: new Date(Date.now() + 10).toISOString(), body: 'Looks risky' },
    { created: new Date(Date.now() + 20).toISOString(), body: 'Reject: not before the release' }
  )
  await decisions.poll()
  expect(await engine.wait(run.id)).toMatchObject({
    status: 'failed',
    nodes: { gate: { decision: { approved: false, by: 'you', via: 'jira', reason: 'not before the release' } } }
  })
  await tick()
  expect(comments.at(-1)?.body).toBe(`Treeix decision [treeix:${run.id}:gate]: Rejected by you in Jira: not before the release.`)
  expect(told).toEqual(['Ticketed: rejected: Rejected by you in Jira: not before the release'])
})

const reviewed = (judge: string, rounds: number, onError: 'stop' | 'continue' = 'stop'): Workflow => ({
  id: 'reviewed',
  name: 'Reviewed',
  updatedAt: 0,
  layout: {},
  nodes: [
    { id: 'input', kind: 'input' },
    agentNode('builder', 'Build {{input}}'),
    { id: 'review', kind: 'judge', agent: judge, source: '{{prev}}', rubric: 'It has tests', minScore: 8, retryStep: 'builder', rounds, onError },
    { id: 'output', kind: 'output', template: 'Shipped: {{prev}}' }
  ],
  edges: [
    { id: '1', from: 'input', to: 'builder', branch: null },
    { id: '2', from: 'builder', to: 'review', branch: null },
    { id: '3', from: 'review', to: 'output', branch: null }
  ]
})

test('a judge reads the score from the reply, prose around the JSON or not', () => {
  expect(parseReview('Here: {"score": 7, "issues": ["a", 2, "b"]} done')).toEqual({ score: 7, issues: ['a', 'b'] })
  expect(parseReview('{"score": "10"}')).toEqual({ score: 10, issues: [] })
  for (const reply of ['{"score": 11}', '{"score": 0}', '{"issues": []}', 'Fine']) expect(() => parseReview(reply)).toThrow('The judge gave no score')
})

test('a low score sends the work back to its step, which resumes with the issues, until it passes', async () => {
  resumed.length = 0
  const run = await engine.wait(engine.launch('workflow', 'Reviewed', reviewed('critic', 2), 'the login').id)
  expect(run?.status).toBe('done')
  expect(run?.nodes.review).toMatchObject({ status: 'done', review: { score: 9, issues: [], round: 2 } })
  expect(run?.nodes.review.prompt).toContain('It has tests')
  expect(run?.nodes.builder.prompt).toStartWith('A reviewer scored your work 3/10; it needs 8. Fix these, then reply as the task asks:\n\n- add a test')
  expect(run?.nodes.builder.prompt).toEndWith('The task, for reference:\nBuild the login')
  // The judge passes the reworked work on, not its verdict
  expect(run?.output).toStartWith('Shipped: builder: A reviewer scored')
  // Builder, critic, the builder again in its own conversation, critic
  expect(resumed).toEqual([null, null, 's', null])
})

test('work that never passes fails the run after its rounds, or goes on when the judge allows it', async () => {
  const failed = await engine.wait(engine.launch('workflow', 'Reviewed', reviewed('harsh', 1), 'the login').id)
  expect(failed).toMatchObject({ status: 'failed', nodes: { review: { status: 'failed', error: 'Scored 3/10, needs 8', review: { score: 3, issues: ['add a test'], round: 2 } } } })

  const went = await engine.wait(engine.launch('workflow', 'Reviewed', reviewed('harsh', 0, 'continue'), 'the login').id)
  expect(went).toMatchObject({ status: 'done', output: 'Shipped: builder: Build the login', nodes: { review: { status: 'failed', review: { round: 1 } } } })

  const garbled = await engine.wait(engine.launch('workflow', 'Reviewed', reviewed('garbled', 2), 'the login').id)
  expect(garbled?.status).toBe('failed')
  expect(garbled?.nodes.review.error).toStartWith('The judge gave no score: Looks fine to me')
})
