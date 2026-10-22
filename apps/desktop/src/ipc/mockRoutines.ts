import type { Api, Routine, RoutineRun, RoutinesEvent } from './api'

// Phase 6 routines demo (owners R6/U7): one routine per trigger, runs that passed, failed, hit the budget and
// were skipped while asleep. Run now finishes after a few seconds; `?seed=empty` starts with none

type RoutinesApi = Pick<
  Api,
  'routineList' | 'routinePut' | 'routineRemove' | 'routineRunNow' | 'routineRuns' | 'routineCancelRun' | 'routineNextFires' | 'onRoutines'
>

const NOW = Date.UTC(2026, 9, 22, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const TREEIX = '/Users/me/projects/treeix'
const BETFEEL = '/Users/me/projects/betfeel/api'

const routine = (r: Pick<Routine, 'id' | 'name' | 'prompt' | 'trigger'> & Partial<Routine>): Routine => ({
  enabled: true,
  agent: 'claude',
  repo: TREEIX,
  place: 'newWorktree',
  permission: 'editFiles',
  allowedTools: [],
  budget: { maxTurns: 30, maxCost: 5 },
  mayPush: false,
  asleep: 'catchUp',
  createdAt: NOW - 30 * DAY,
  ...r,
})

const ROUTINES: Routine[] = [
  routine({ id: 'rt-review', name: 'Review requested PRs', prompt: 'Review PR {pr} "{title}" by {author}. Leave inline comments for real problems only.', trigger: { kind: 'event', event: 'reviewRequested' }, repo: null, place: 'prWorktree', permission: 'readOnly', mayPush: true }),
  routine({ id: 'rt-ci', name: 'Fix failing CI', prompt: 'CI job {job} failed on {branch} ({pr}). Find the cause, fix it and push.', trigger: { kind: 'event', event: 'ciFailed' }, repo: null, place: 'prWorktree', allowedTools: ['Bash(bun test:*)', 'Bash(cargo test:*)'], mayPush: true, budget: { maxTurns: 40, maxCost: 3 } }),
  routine({ id: 'rt-digest', name: 'Morning digest', prompt: 'Summarize what changed on main since yesterday and what is waiting on me.', trigger: { kind: 'schedule', cron: '0 9 * * 1-5' }, place: 'root', permission: 'readOnly', budget: { maxTurns: 10, maxCost: 1 } }),
  routine({ id: 'rt-deps', name: 'Weekly dependency bumps', prompt: 'Bump patch versions of dependencies, run the tests and open a PR.', trigger: { kind: 'schedule', cron: '0 7 * * 1' }, agent: 'codex', repo: BETFEEL, asleep: 'skip', mayPush: true }),
  routine({ id: 'rt-ticket', name: 'Start assigned tickets', prompt: 'Read {ticket} "{title}": {desc}\nPlan the change and stop before editing.', trigger: { kind: 'event', event: 'ticketAssigned' }, permission: 'readOnly' }),
  routine({ id: 'rt-hook', name: 'Sentry alert triage', prompt: 'A Sentry alert came in:\n{body}\nFind the likely cause.', trigger: { kind: 'webhook', token: 'whk_7f3a9c2e41b8' }, repo: BETFEEL, place: 'root', permission: 'readOnly', enabled: false }),
]

const run = (r: Partial<RoutineRun> & Pick<RoutineRun, 'id' | 'routine' | 'cause' | 'status' | 'dueAt'>): RoutineRun => {
  const name = ROUTINES.find((x) => x.id === r.routine)?.name ?? r.routine
  const started = r.status === 'skipped' ? null : r.dueAt
  return { name, detail: null, startedAt: started, endedAt: started && started + 6 * MIN, session: null, cwd: null, turns: 0, cost: 0, error: null, ...r }
}

const RUNS: RoutineRun[] = [
  run({ id: 'run-1', routine: 'rt-review', cause: 'event', status: 'ok', dueAt: NOW - 2 * HOUR, detail: '#412 Fix login redirect (octocat)', cwd: `${TREEIX}/.claude/worktrees/pr-412`, session: 'r1', turns: 14, cost: 0.62 }),
  run({ id: 'run-2', routine: 'rt-ci', cause: 'event', status: 'failed', dueAt: NOW - 5 * HOUR, detail: '#405 typecheck on feat/ports', cwd: `${TREEIX}/.claude/worktrees/pr-405`, session: 'r2', turns: 22, cost: 1.48, error: 'claude exited with code 1' }),
  run({ id: 'run-3', routine: 'rt-ci', cause: 'event', status: 'overBudget', dueAt: NOW - DAY, detail: '#398 e2e on fix/pty-leak', cwd: `${TREEIX}/.claude/worktrees/pr-398`, session: 'r3', turns: 31, cost: 3.02, error: 'Stopped at the $3.00 budget' }),
  run({ id: 'run-4', routine: 'rt-digest', cause: 'catchUp', status: 'ok', dueAt: NOW - 3 * HOUR, cwd: TREEIX, session: 'r4', turns: 6, cost: 0.18 }),
  run({ id: 'run-5', routine: 'rt-deps', cause: 'schedule', status: 'skipped', dueAt: NOW - 2 * DAY - 5 * HOUR, error: 'The Mac was asleep' }),
  run({ id: 'run-6', routine: 'rt-ticket', cause: 'event', status: 'ok', dueAt: NOW - 2 * DAY, detail: 'TRX-52 Usage pill shows the weekly limit', cwd: `${TREEIX}/.claude/worktrees/trx-52`, session: 'r6', turns: 9, cost: 0.41 }),
  run({ id: 'run-7', routine: 'rt-digest', cause: 'manual', status: 'cancelled', dueAt: NOW - 3 * DAY, cwd: TREEIX, turns: 2, cost: 0.04, error: 'Cancelled' }),
]

/** Minute-hour crons with `*`, `1-5` or one weekday, in UTC; anything else fires hourly. ptyd does real cron */
function nextFires(cron: string, count: number): number[] {
  const [minute, hour, , , weekday, ...rest] = cron.trim().split(/\s+/)
  if (weekday === undefined || rest.length) throw new Error(`invalid schedule: ${cron}`)
  const n = Math.min(count, 20)
  if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '')) return Array.from({ length: n }, (_, i) => (Math.floor(NOW / HOUR) + 1 + i) * HOUR)
  const out: number[] = []
  for (let d = 0; out.length < n && d < 400; d++) {
    const at = Date.UTC(2026, 9, 22 + d, Number(hour), Number(minute))
    const day = new Date(at).getUTCDay()
    const fits = weekday === '*' || (weekday === '1-5' ? day >= 1 && day <= 5 : String(day) === weekday)
    if (at > NOW && fits) out.push(at)
  }
  return out
}

export function routinesMock(): RoutinesApi {
  const seeded = new URLSearchParams(location.search).get('seed') !== 'empty'
  const routines = new Map((seeded ? ROUTINES : []).map((r) => [r.id, { ...r }]))
  let runs = seeded ? RUNS.map((r) => ({ ...r })) : []
  const listeners = new Set<(e: RoutinesEvent) => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let next = 1
  const fire = (e: RoutinesEvent) => listeners.forEach((cb) => cb(e))
  const update = (id: string, patch: Partial<RoutineRun>) => {
    runs = runs.map((r) => (r.id === id ? { ...r, ...patch } : r))
    const changed = runs.find((r) => r.id === id)
    if (changed) fire({ type: 'run', run: changed })
  }
  const get = (id: string) => {
    const found = routines.get(id)
    if (!found) throw new Error(`no routine ${id}`)
    return found
  }

  return {
    routineList: async () => [...routines.values()].sort((a, b) => a.name.localeCompare(b.name)),
    async routinePut(input) {
      if (!input.name.trim()) throw new Error('a routine needs a name')
      if (input.trigger.kind === 'schedule') nextFires(input.trigger.cron, 1)
      const id = input.id || `rt-${next++}`
      const trigger = input.trigger.kind === 'webhook' && !input.trigger.token ? { kind: 'webhook' as const, token: `whk_${id}` } : input.trigger
      const saved = { ...input, id, trigger, createdAt: routines.get(id)?.createdAt ?? Date.now() }
      routines.set(id, saved)
      fire({ type: 'changed', routine: saved })
      return saved
    },
    async routineRemove(id) {
      if (routines.delete(id)) fire({ type: 'removed', routine: id })
    },
    async routineRunNow(id) {
      const r = get(id)
      const started = Date.now()
      const created: RoutineRun = { ...run({ id: `run-new-${next++}`, routine: id, cause: 'manual', status: 'running', dueAt: started }), name: r.name, endedAt: null, cwd: r.repo }
      runs = [created, ...runs]
      fire({ type: 'run', run: created })
      timers.set(created.id, setTimeout(() => update(created.id, { status: 'ok', endedAt: Date.now(), turns: 7, cost: 0.23 }), 3000))
      return created
    },
    routineRuns: async (routine, limit) => runs.filter((r) => routine === null || r.routine === routine).sort((a, b) => b.dueAt - a.dueAt).slice(0, limit),
    async routineCancelRun(id) {
      clearTimeout(timers.get(id))
      update(id, { status: 'cancelled', endedAt: Date.now(), error: 'Cancelled' })
    },
    routineNextFires: async (cron, count) => nextFires(cron, count),
    onRoutines(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
