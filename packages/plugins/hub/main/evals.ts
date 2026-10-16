import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseJson } from '@treeix/shared/json'
import { cronMatches } from '../shared/cron'
import { batchesOf, type CheckResult, type EvalCase, type EvalCheck, type EvalResult, type EvalSuite, isEvalResult } from '../shared/evals'
import { type Decider, MAX_SCORE, type Run, type Workflow } from '../shared/workflow'
import type { createEngine } from './engine'

type Engine = Pick<ReturnType<typeof createEngine>, 'launch' | 'wait' | 'decide' | 'answer' | 'questions'>

const exec = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10 * 60_000
const DETAIL_CHARS = 1000
const TITLE_CHARS = 80
const BY_EVAL: Decider = { by: 'eval', via: 'app', reason: 'Evals let every approval through' }
const DENIED: Decider = { by: 'eval', via: 'app', reason: 'Evals allow nothing an agent asks; let the agent allow everything to test this' }

/** The judge alone as a run: the output comes in as the input and is scored once, never sent back */
const judgeWorkflow = (check: Extract<EvalCheck, { kind: 'judge' }>, reference: string | null): Workflow => ({
  id: 'eval-judge',
  name: 'Eval judge',
  nodes: [
    { id: 'input', kind: 'input' },
    {
      id: 'review',
      kind: 'judge',
      agent: check.agent,
      source: '{{input}}',
      rubric: reference ? `${check.rubric}\n\nA reference answer, as good as the work needs to be:\n${reference}` : check.rubric,
      minScore: check.minScore,
      retryStep: null,
      rounds: 0,
      onError: 'continue'
    },
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ],
  edges: [
    { id: 'input-review', from: 'input', to: 'review', branch: null },
    { id: 'review-output', from: 'review', to: 'output', branch: null }
  ],
  layout: {},
  updatedAt: 0
})

const firstError = (run: Run | null): string => (run ? (Object.values(run.nodes).find((node) => node.error)?.error ?? run.status) : 'The run is gone')

const failure = (error: unknown): string => {
  const output =
    error && typeof error === 'object' ? [Reflect.get(error, 'stdout'), Reflect.get(error, 'stderr')].filter((part) => typeof part === 'string' && part.trim()).join('\n') : ''
  return (output || (error instanceof Error ? error.message : String(error))).trim().slice(-DETAIL_CHARS)
}

/**
 * Runs suites of cases against a workflow or agent and keeps every result in `<dir>/<suite>.jsonl`. Eval runs answer their
 * own waits at once: approvals pass, permissions are refused, so a suite never stops for anyone.
 */
export function createEvals(deps: {
  engine: Engine
  suites: () => Promise<EvalSuite[]>
  /** What the suite's cases run: its workflow, or its agent alone; throws when it can't start */
  workflowOf: (suite: EvalSuite) => Promise<Workflow>
  /** Where commands run when their check names no folder */
  folderOf: (suite: EvalSuite) => Promise<string | null>
  dir: string
  shell: string
  onResult: (suite: string, result: EvalResult) => void
  onBusy: (suites: string[]) => void
  notify: (title: string, body: string, runId: string | null) => void
}) {
  const { engine } = deps
  const running = new Set<string>()
  const file = (suite: string): string => join(deps.dir, `${suite}.jsonl`)

  const results = async (suite: string): Promise<EvalResult[]> =>
    (await readFile(file(suite), 'utf8').catch(() => ''))
      .split('\n')
      .flatMap((line) => (line ? [parseJson(line)] : []))
      .filter(isEvalResult)

  async function check(entry: EvalCheck, output: string, item: EvalCase, folder: string | null): Promise<CheckResult> {
    const result = (pass: boolean, detail: string, extra: Partial<CheckResult> = {}): CheckResult => ({ check: entry.id, pass, detail, ...extra })
    switch (entry.kind) {
      case 'contains':
        return output.toLowerCase().includes(entry.value.toLowerCase()) ? result(true, '') : result(false, `"${entry.value}" is not in the output`)
      case 'regex':
        try {
          return new RegExp(entry.value).test(output) ? result(true, '') : result(false, `Nothing matches ${entry.value}`)
        } catch {
          return result(false, `${entry.value} is not a valid pattern`)
        }
      case 'command':
        try {
          await exec(deps.shell, ['-lc', entry.command], { cwd: entry.folder ?? folder ?? homedir(), timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, OUTPUT: output } })
          return result(true, '')
        } catch (error) {
          return result(false, failure(error))
        }
      case 'judge': {
        const run = engine.launch('eval', `Judge: ${item.name}`.slice(0, TITLE_CHARS), judgeWorkflow(entry, item.reference), output)
        const node = (await engine.wait(run.id))?.nodes.review
        if (!node?.review) return result(false, node?.error ?? 'The judge gave no score', { runId: run.id })
        const { score, issues } = node.review
        return result(score >= entry.minScore, [`${score}/${MAX_SCORE}`, ...issues].join('; '), { runId: run.id, score })
      }
    }
  }

  async function runCase(suite: EvalSuite, workflow: Workflow, item: EvalCase, folder: string | null, batch: string): Promise<EvalResult> {
    const base = { batch, at: Date.now(), case: item.id, name: item.name }
    try {
      const run = engine.launch('eval', `${suite.name}: ${item.name}`.slice(0, TITLE_CHARS), workflow, item.input)
      const ended = await engine.wait(run.id)
      if (ended?.status !== 'done')
        return { ...base, runId: run.id, pass: false, score: null, checks: [{ check: 'run', pass: false, detail: `The run did not finish: ${firstError(ended)}` }] }
      const checks: CheckResult[] = []
      // One at a time, as a judge's run and a command can both touch the case's folder
      for (const entry of item.checks) checks.push(await check(entry, ended.output ?? '', item, folder))
      const scores = checks.flatMap((entry) => (entry.score === undefined ? [] : [entry.score]))
      return {
        ...base,
        runId: run.id,
        pass: checks.every((entry) => entry.pass),
        score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
        checks
      }
    } catch (error) {
      return { ...base, runId: null, pass: false, score: null, checks: [{ check: 'run', pass: false, detail: failure(error) }] }
    }
  }

  async function runSuite(suite: EvalSuite, workflow: Workflow): Promise<void> {
    const before = batchesOf(await results(suite.id))[0]
    const folder = await deps.folderOf(suite)
    const batch = randomUUID()
    const ran: EvalResult[] = []
    await mkdir(deps.dir, { recursive: true })
    // ponytail: cases run one at a time, since code tasks share their repo folder; run per folder in parallel if suites get slow
    for (const item of suite.cases) {
      const result = await runCase(suite, workflow, item, folder, batch)
      ran.push(result)
      await appendFile(file(suite.id), `${JSON.stringify(result)}\n`)
      deps.onResult(suite.id, result)
    }
    const passed = ran.filter((result) => result.pass).length
    if (before && passed / ran.length < before.passed / before.total)
      deps.notify(
        `${suite.name} got worse`,
        `${passed} of ${ran.length} cases pass, down from ${before.passed} of ${before.total}`,
        ran.find((result) => !result.pass)?.runId ?? null
      )
  }

  /** Starts a run of every case; rejects at once when the suite can't start */
  async function start(id: string): Promise<void> {
    if (running.has(id)) throw new Error('The suite is already running')
    const suite = (await deps.suites()).find((entry) => entry.id === id)
    if (!suite) throw new Error('The suite is gone')
    if (suite.cases.length === 0) throw new Error('Add a case first')
    const workflow = await deps.workflowOf(suite)
    running.add(id)
    deps.onBusy([...running])
    void runSuite(suite, workflow)
      .catch((error: unknown) => deps.notify(`${suite.name} could not finish`, failure(error), null))
      .finally(() => (running.delete(id), deps.onBusy([...running])))
  }

  return {
    start,
    results,
    running: (): string[] => [...running],
    remove: (suite: string): Promise<void> => rm(file(suite), { force: true }),
    /** Starts the suites whose schedule is due */
    fire: async (now: Date): Promise<void> => {
      for (const suite of await deps.suites())
        if (suite.cron && cronMatches(suite.cron, now) && !running.has(suite.id))
          await start(suite.id).catch((error: unknown) => deps.notify(`${suite.name}'s schedule can't run it`, failure(error), null))
    },
    /** Answers what an eval run waits on, after the change that made it wait is done */
    onRun: (run: Run): void => {
      if (run.kind !== 'eval' || run.status !== 'running') return
      for (const [node, state] of Object.entries(run.nodes)) {
        if (state.waiting === 'approval') queueMicrotask(() => engine.decide(run.id, node, true, BY_EVAL))
        if (state.waiting !== 'permission') continue
        queueMicrotask(() => {
          for (const asked of engine.questions(run.id).filter((question) => question.node === node))
            engine.answer(run.id, node, asked.requestId, asked.options.find((option) => option.kind.startsWith('reject'))?.id ?? null, DENIED)
        })
      }
    }
  }
}
