import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvalResult, EvalSuite } from '../shared/evals'
import { askWorkflow, freshNode, type NodeRun, type Run, type Workflow } from '../shared/workflow'
import { createEvals } from './evals'

/** Runs end at once: the agent echoes its input, failing on "crash"; the judge scores 9 when the work says "good", else 4 */
function fakeEngine() {
  const runs = new Map<string, Run>()
  const decided: string[] = []
  return {
    runs,
    decided,
    launch: (kind: Run['kind'], title: string, workflow: Workflow, input: string): Run => {
      const id = `run${runs.size}`
      const judging = workflow.nodes.some((node) => node.kind === 'judge')
      const nodes: Record<string, NodeRun> = Object.fromEntries(workflow.nodes.map((node) => [node.id, { ...freshNode(), status: 'done' }]))
      if (judging) nodes.review.review = { score: input.includes('good') ? 9 : 4, issues: input.includes('good') ? [] : ['say it better'], round: 1 }
      const failed = input.includes('crash')
      if (failed) nodes.agent = { ...nodes.agent, status: 'failed', error: 'The agent crashed' }
      const run: Run = { id, kind, title, workflow, input, status: failed ? 'failed' : 'done', startedAt: 0, endedAt: 0, nodes, output: judging ? input : `Answer: ${input}` }
      runs.set(id, run)
      return run
    },
    wait: async (id: string) => runs.get(id) ?? null,
    decide: (id: string, node: string) => void decided.push(`${id}:${node}`),
    answer: () => undefined,
    questions: () => []
  }
}

const suite = (cases: EvalSuite['cases']): EvalSuite => ({ id: 's', name: 'Notes', target: { kind: 'agent', id: 'writer' }, cases, cron: '0 3 * * *', updatedAt: 0 })

function setup(cases: EvalSuite['cases']) {
  const engine = fakeEngine()
  const results: EvalResult[] = []
  const notices: string[] = []
  let current = suite(cases)
  let idle: () => void = () => undefined
  const evals = createEvals({
    engine,
    suites: async () => [current],
    workflowOf: async () => askWorkflow('writer', null),
    folderOf: async () => tmpdir(),
    dir: mkdtempSync(join(tmpdir(), 'evals-')),
    shell: '/bin/sh',
    onResult: (_, result) => results.push(result),
    onBusy: (busy) => busy.length === 0 && idle(),
    notify: (title, body) => notices.push(`${title}: ${body}`)
  })
  const run = async (): Promise<void> => {
    const done = new Promise<void>((resolve) => (idle = resolve))
    await evals.start('s')
    await done
  }
  return { engine, evals, results, notices, run, change: (cases: EvalSuite['cases']) => (current = suite(cases)) }
}

test('each check kind scores the output, and a run that fails fails its case', async () => {
  const { results, run, engine } = setup([
    {
      id: 'a',
      name: 'Good note',
      input: 'a good note',
      reference: null,
      checks: [
        { id: 'c1', kind: 'contains', value: 'GOOD' },
        { id: 'c2', kind: 'regex', value: '^Answer: ' },
        { id: 'c3', kind: 'command', command: 'test "$OUTPUT" = "Answer: a good note"', folder: null },
        { id: 'c4', kind: 'judge', agent: 'critic', rubric: 'Clear', minScore: 8 }
      ]
    },
    {
      id: 'b',
      name: 'Weak note',
      input: 'a note',
      reference: 'A great note',
      checks: [
        { id: 'c1', kind: 'contains', value: 'missing' },
        { id: 'c2', kind: 'regex', value: '(' },
        { id: 'c3', kind: 'command', command: 'echo broken >&2; exit 3', folder: null },
        { id: 'c4', kind: 'judge', agent: 'critic', rubric: 'Clear', minScore: 8 }
      ]
    },
    { id: 'c', name: 'Crash', input: 'crash', reference: null, checks: [{ id: 'c1', kind: 'contains', value: 'x' }] }
  ])
  await run()
  expect(results.map((result) => [result.name, result.pass, result.score])).toEqual([
    ['Good note', true, 9],
    ['Weak note', false, 4],
    ['Crash', false, null]
  ])
  const [missing, pattern, command, judge] = results[1].checks.map((check) => check.detail)
  expect([missing, pattern, judge]).toEqual(['"missing" is not in the output', '( is not a valid pattern', '4/10; say it better'])
  // A login shell, so whatever the user's profile prints comes first
  expect(command).toEndWith('broken')
  expect(results[2].checks).toEqual([{ check: 'run', pass: false, detail: 'The run did not finish: The agent crashed' }])
  // The judge sees the reference and runs as an eval of its own
  const judged = [...engine.runs.values()].filter((entry) => entry.title.startsWith('Judge:'))
  expect(judged.map((entry) => entry.kind)).toEqual(['eval', 'eval'])
  const rubric = (entry: Run): string => (entry.workflow.nodes[1].kind === 'judge' ? entry.workflow.nodes[1].rubric : '')
  expect(rubric(judged[1])).toContain('A reference answer, as good as the work needs to be:\nA great note')
})

test('results are kept per run of the suite, and a drop in passing cases is told', async () => {
  const good = { id: 'a', name: 'Good', input: 'good', reference: null, checks: [{ id: 'c', kind: 'contains' as const, value: 'good' }] }
  const { evals, notices, run, change } = setup([good, { ...good, id: 'b' }])
  await run()
  expect(notices).toEqual([])
  change([good, { ...good, id: 'b', input: 'bad' }])
  await run()
  expect(notices).toEqual(['Notes got worse: 1 of 2 cases pass, down from 2 of 2'])
  expect((await evals.results('s')).length).toBe(4)
  await expect(evals.start('gone')).rejects.toThrow('The suite is gone')
})

test('a suite starts on its schedule, and an eval run waiting for approval goes on by itself', async () => {
  const { evals, engine } = setup([{ id: 'a', name: 'A', input: 'x', reference: null, checks: [] }])
  await evals.fire(new Date(2026, 0, 1, 4, 0))
  expect(engine.runs.size).toBe(0)
  await evals.fire(new Date(2026, 0, 1, 3, 0))
  expect(evals.running()).toEqual(['s'])

  const waiting: Run = {
    ...engine.launch('eval', 'Gate', askWorkflow('writer', null), 'x'),
    status: 'running',
    nodes: { gate: { ...freshNode(), status: 'running', waiting: 'approval' } }
  }
  evals.onRun(waiting)
  evals.onRun({ ...waiting, kind: 'workflow', id: 'mine' })
  await Promise.resolve()
  expect(engine.decided).toEqual([`${waiting.id}:gate`])
})
