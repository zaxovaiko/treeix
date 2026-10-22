import { expect, test } from 'bun:test'
import type { RoutineRun } from '../../ipc/api'
import { cronOf, fixDraft, lastRunText, newRoutine, parseAmount, parseCron, problem, runCost, scheduleText, webhookUrl, whenLabel, whenText, whereText } from './logic'

test('parseCron reads the presets and calls the rest custom', () => {
  expect(parseCron('0 9 * * 1-5')).toEqual({ every: 'weekdays', at: '09:00' })
  expect(parseCron('30 7 * * 1')).toEqual({ every: 'monday', at: '07:30' })
  expect(parseCron(' 5 18 * * * ')).toEqual({ every: 'day', at: '18:05' })
  expect(parseCron('0 * * * *').every).toBe('hour')
  for (const cron of ['15 * * * *', '0 9 1 * *', '*/5 9 * * *', '0 9 * * 0', '0 25 * * *', '0 9 * *']) expect(parseCron(cron).every).toBe('custom')
})

test('cronOf round-trips through parseCron', () => {
  expect(cronOf('weekdays', '09:00', '')).toBe('0 9 * * 1-5')
  expect(cronOf('monday', '07:30', '')).toBe('30 7 * * 1')
  expect(cronOf('hour', '07:30', '')).toBe('0 * * * *')
  expect(cronOf('custom', '07:30', '0 9 1 * *')).toBe('0 9 1 * *')
  expect(parseCron(cronOf('day', '23:59', ''))).toEqual({ every: 'day', at: '23:59' })
})

test('scheduleText and whenText say it in words', () => {
  expect(scheduleText('0 9 * * 1-5')).toBe('Weekdays at 9:00')
  expect(scheduleText('0 7 * * 1')).toBe('Every Monday at 7:00')
  expect(scheduleText('0 * * * *')).toBe('Every hour')
  expect(scheduleText('0 9 1 * *')).toBe('On cron 0 9 1 * *')
  expect(whenText({ trigger: { kind: 'event', event: 'ciFailed' } })).toBe('CI fails on one of your PRs')
  expect(whenText({ trigger: { kind: 'webhook', token: 'x' } })).toBe('When its webhook is called')
})

test('whereText names the place', () => {
  const event = { kind: 'event', event: 'reviewRequested' } as const
  expect(whereText({ trigger: event, repo: null, place: 'prWorktree' })).toBe("in the PR's worktree")
  expect(whereText({ trigger: event, repo: null, place: 'root' })).toBe("in the PR's repo")
  expect(whereText({ trigger: { kind: 'event', event: 'ticketAssigned' }, repo: null, place: 'newWorktree' })).toBe("in a new worktree of the ticket's repo")
  expect(whereText({ trigger: { kind: 'schedule', cron: '' }, repo: '/p/treeix', place: 'root' })).toBe('in treeix')
})

test('problem blocks drafts ptyd would reject or could not run', () => {
  const ok = { ...newRoutine('/p/treeix'), name: 'Digest', prompt: 'Summarize' }
  expect(problem(ok)).toBeNull()
  expect(problem({ ...ok, name: ' ' })).toBe('Name the routine')
  expect(problem({ ...ok, prompt: '' })).toBe('Write the prompt')
  expect(problem({ ...ok, trigger: { kind: 'schedule', cron: '0 9 * *' } })).toContain('5 fields')
  expect(problem({ ...ok, repo: null })).toBe('Pick the folder it runs in')
  expect(problem({ ...ok, repo: null, trigger: { kind: 'event', event: 'ciFailed' } })).toBeNull()
  expect(problem({ ...ok, place: 'prWorktree', trigger: { kind: 'event', event: 'ticketAssigned' } })).toContain("PR's worktree")
  expect(problem({ ...ok, budget: { maxCost: 0, maxTurns: null } })).toContain('budget')
  expect(problem({ ...ok, budget: { maxCost: Number.NaN, maxTurns: null } })).toContain('budget')
  expect(problem({ ...ok, budget: { maxCost: null, maxTurns: 2.5 } })).toContain('turns')
  expect(problem({ ...ok, budget: { maxCost: null, maxTurns: null } })).toBeNull()
})

test('fixDraft keeps a draft valid when its trigger changes', () => {
  const pr = { ...newRoutine(null), trigger: { kind: 'event', event: 'ciFailed' } as const, place: 'prWorktree' as const }
  expect(fixDraft(pr, '/p/a')).toBe(pr)
  const scheduled = fixDraft({ ...pr, trigger: { kind: 'schedule', cron: '0 9 * * *' } }, '/p/a')
  expect(scheduled.repo).toBe('/p/a')
  expect(scheduled.place).toBe('root')
})

test('fixDraft keeps the result valid for the place and comments for PR events', () => {
  const bump = { ...newRoutine('/p/a'), place: 'newWorktree' as const, result: 'draftPr' as const }
  expect(fixDraft(bump, '/p/a')).toBe(bump)
  expect(fixDraft({ ...bump, place: 'root' }, '/p/a').result).toBe('local')
  expect(fixDraft({ ...bump, place: 'prWorktree' }, '/p/a').result).toBe('local')
  const review = { ...newRoutine(null), trigger: { kind: 'event', event: 'reviewRequested' } as const, place: 'prWorktree' as const, mayComment: true }
  expect(fixDraft(review, '/p/a').mayComment).toBe(true)
  expect(fixDraft({ ...review, trigger: { kind: 'schedule', cron: '0 9 * * *' } }, '/p/a').mayComment).toBe(false)
})

test('parseAmount: empty is no limit, garbage is NaN', () => {
  expect(parseAmount('')).toBeNull()
  expect(parseAmount(' $2.5 ')).toBe(2.5)
  expect(parseAmount('two')).toBeNaN()
})

test('whenLabel is relative to today, in local time', () => {
  const now = new Date(2026, 9, 22, 12).getTime()
  expect(whenLabel(new Date(2026, 9, 22, 9).getTime(), now)).toBe('Today 9:00')
  expect(whenLabel(new Date(2026, 9, 21, 23, 5).getTime(), now)).toBe('Yesterday 23:05')
  expect(whenLabel(new Date(2026, 9, 23, 7).getTime(), now)).toBe('Tomorrow 7:00')
  expect(whenLabel(new Date(2026, 9, 19, 7).getTime(), now)).toBe('Mon 7:00')
  expect(whenLabel(new Date(2026, 9, 3, 7).getTime(), now)).toBe('Oct 3 7:00')
})

const run = (r: Partial<RoutineRun>): RoutineRun => ({
  id: 'r',
  routine: 'rt',
  name: 'Digest',
  cause: 'schedule',
  status: 'ok',
  detail: null,
  dueAt: new Date(2026, 9, 22, 9).getTime(),
  startedAt: new Date(2026, 9, 22, 9).getTime(),
  endedAt: null,
  session: null,
  cwd: null,
  turns: 1,
  cost: 0.18,
  error: null,
  ...r,
})

test('lastRunText says how the newest run went', () => {
  const now = new Date(2026, 9, 22, 12).getTime()
  expect(lastRunText(undefined, now)).toEqual(['Not run yet', ''])
  expect(lastRunText(run({}), now)).toEqual(['Last run Today 9:00: Done', ''])
  expect(lastRunText(run({ status: 'overBudget', error: 'Stopped at the $5.00 budget' }), now)).toEqual(['Last run Today 9:00: Stopped at the $5.00 budget', 'st-err'])
  expect(lastRunText(run({ status: 'skipped', startedAt: null, error: 'The Mac was asleep' }), now)).toEqual(['Missed Today 9:00: The Mac was asleep', 'warn'])
  expect(lastRunText(run({ status: 'running', detail: '#412 Fix login' }), now)).toEqual(['Running · #412 Fix login', 'st-run'])
  expect(runCost(run({}))).toBe('1 turn · $0.18')
  expect(runCost(run({ startedAt: null }))).toBe('')
})

test('webhookUrl listens on localhost with the token', () => {
  expect(webhookUrl('whk_1')).toBe('http://127.0.0.1:47311/r/whk_1')
})
