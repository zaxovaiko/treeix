import { WEBHOOK_PORT, type Routine, type RoutineEvent, type RoutinePlace, type RoutineResult, type RoutineRun, type RunCause, type RunStatus } from '../../ipc/api'

// Pure helpers of the routines UI: schedule text and cron, validation, run status

const DAY = 24 * 60 * 60_000

/** [seg label, what happens, prompt variables] (crates/proto routines.rs) */
export const EVENTS: Record<RoutineEvent, [label: string, what: string, vars: string]> = {
  reviewRequested: ['Review requested', 'Someone asks you to review a PR', '{pr} {title} {author}'],
  ciFailed: ['CI failed', 'CI fails on one of your PRs', '{pr} {branch} {job}'],
  prComment: ['PR comment', 'Someone comments on one of your PRs', '{pr} {author} {comment}'],
  ticketAssigned: ['Ticket assigned', 'A Jira ticket is assigned to you', '{ticket} {title} {desc}'],
}

export const isPrEvent = (r: Pick<Routine, 'trigger'>) => r.trigger.kind === 'event' && r.trigger.event !== 'ticketAssigned'

export const EVERY = { hour: 'Every hour', day: 'Every day', weekdays: 'Weekdays', monday: 'Every Monday', custom: 'Custom (cron)' } as const
export type Every = keyof typeof EVERY

const WEEKDAYS: Partial<Record<Every, string>> = { day: '*', weekdays: '1-5', monday: '1' }

/** The editor's Every and At for a cron; anything the presets can't say is `custom` */
export function parseCron(cron: string): { every: Every; at: string } {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return { every: 'custom', at: '09:00' }
  const [minute, hour, , , weekday] = f
  if (cron.trim() === '0 * * * *') return { every: 'hour', at: '09:00' }
  const every = (Object.keys(WEEKDAYS) as Every[]).find((k) => WEEKDAYS[k] === weekday)
  const h = Number(hour)
  const m = Number(minute)
  if (!every || !/^\d+$/.test(hour) || !/^\d+$/.test(minute) || h > 23 || m > 59) return { every: 'custom', at: '09:00' }
  return { every, at: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
}

/** Every and At (HH:MM) as a cron; `custom` keeps `cron` */
export function cronOf(every: Every, at: string, cron: string): string {
  if (every === 'custom') return cron
  if (every === 'hour') return '0 * * * *'
  const [h, m] = at.split(':').map(Number)
  return `${m || 0} ${h || 0} * * ${WEEKDAYS[every]}`
}

const clock = (at: string) => at.replace(/^0(?=\d)/, '')

/** "Weekdays at 9:00", "Every hour", "On cron 0 9 1 * *" */
export function scheduleText(cron: string): string {
  const { every, at } = parseCron(cron)
  if (every === 'custom') return `On cron ${cron.trim()}`
  return every === 'hour' ? EVERY.hour : `${EVERY[every]} at ${clock(at)}`
}

export function whenText(r: Pick<Routine, 'trigger'>): string {
  const t = r.trigger
  return t.kind === 'schedule' ? scheduleText(t.cron) : t.kind === 'event' ? EVENTS[t.event][1] : 'When its webhook is called'
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

export function whereText(r: Pick<Routine, 'trigger' | 'repo' | 'place'>): string {
  if (r.place === 'prWorktree') return "in the PR's worktree"
  const repo = r.repo ? baseName(r.repo) : r.trigger.kind === 'event' && r.trigger.event === 'ticketAssigned' ? "the ticket's repo" : "the PR's repo"
  return `in ${r.place === 'newWorktree' ? 'a new worktree of ' : ''}${repo}`
}

export const webhookUrl = (token: string) => `http://127.0.0.1:${WEBHOOK_PORT}/r/${token}`

/** Why the draft can't be saved, or null */
export function problem(r: Routine): string | null {
  if (!r.name.trim()) return 'Name the routine'
  if (!r.prompt.trim()) return 'Write the prompt'
  if (r.trigger.kind === 'schedule' && r.trigger.cron.trim().split(/\s+/).length !== 5) return 'A cron has 5 fields: minute hour day month weekday'
  if (!r.repo && r.trigger.kind !== 'event') return 'Pick the folder it runs in'
  if (r.place === 'prWorktree' && !isPrEvent(r)) return "Only PR events have a PR's worktree"
  const { maxCost, maxTurns } = r.budget
  if (maxCost !== null && !(maxCost > 0)) return 'The budget is an amount above $0'
  if (maxTurns !== null && !(Number.isInteger(maxTurns) && maxTurns > 0)) return 'Max turns is a whole number above 0'
  return null
}

/** [result, label, what happens] each place offers; the repo folder only keeps things local */
export const RESULTS: Record<RoutinePlace, [RoutineResult, string, string][]> = {
  root: [],
  newWorktree: [
    ['local', 'Local commits', 'Commits stay on the run\'s branch for you to look at'],
    ['draftPr', 'Draft PR', 'Treeix pushes and opens a draft PR; while it is open, later runs add to it'],
  ],
  prWorktree: [
    ['local', 'Local commits', 'Commits stay in the PR\'s worktree for you to push'],
    ['pushToPr', 'Push to the PR', 'Treeix pushes the commits to the PR after a clean run'],
  ],
}

/** Keeps a draft valid after its trigger or place changes: "the PR's repo" needs an event, a PR's worktree a PR
 * event, a result its place, comments a PR */
export function fixDraft(r: Routine, fallbackRepo: string | null): Routine {
  const repo = !r.repo && r.trigger.kind !== 'event' ? fallbackRepo : r.repo
  const place = r.place === 'prWorktree' && !isPrEvent(r) ? 'root' : r.place
  const result = RESULTS[place].some(([x]) => x === r.result) ? r.result : 'local'
  const mayComment = !!r.mayComment && isPrEvent(r)
  return repo === r.repo && place === r.place && result === r.result && mayComment === r.mayComment ? r : { ...r, repo, place, result, mayComment }
}

export const newRoutine = (repo: string | null): Routine => ({
  id: '',
  name: '',
  enabled: true,
  agent: 'claude',
  prompt: '',
  trigger: { kind: 'schedule', cron: '0 9 * * 1-5' },
  repo,
  place: 'root',
  permission: 'readOnly',
  allowedTools: [],
  budget: { maxTurns: null, maxCost: 1 },
  result: 'local',
  mayComment: false,
  asleep: 'catchUp',
  createdAt: 0,
})

/** Starting points shown while there are no routines (the prototype's) */
export const TEMPLATES: (Partial<Routine> & Pick<Routine, 'name' | 'prompt' | 'trigger'>)[] = [
  { name: 'Review PRs that ask for me', trigger: { kind: 'event', event: 'reviewRequested' }, repo: null, place: 'prWorktree', budget: { maxTurns: null, maxCost: 2 }, prompt: 'Review {pr} "{title}" by {author}. Correctness first, then tests. Draft comments I can post.' },
  { name: 'Fix CI on my PRs', agent: 'codex', trigger: { kind: 'event', event: 'ciFailed' }, repo: null, place: 'prWorktree', permission: 'editFiles', budget: { maxTurns: null, maxCost: 3 }, result: 'pushToPr', prompt: 'CI failed on {pr} ({job}) on {branch}. Find the cause and fix it.' },
  { name: 'Morning digest', trigger: { kind: 'schedule', cron: '0 9 * * 1-5' }, prompt: 'Summarize yesterday: my commits, open PRs waiting on me and tickets assigned to me.' },
  { name: 'Bump dependencies', agent: 'codex', trigger: { kind: 'schedule', cron: '0 7 * * 1' }, place: 'newWorktree', permission: 'editFiles', budget: { maxTurns: null, maxCost: 2 }, result: 'draftPr', prompt: 'Update patch and minor dependencies and run the tests. End with the changelog links of what you bumped.' },
  { name: 'Start tickets assigned to me', trigger: { kind: 'event', event: 'ticketAssigned' }, repo: null, place: 'newWorktree', permission: 'editFiles', budget: { maxTurns: null, maxCost: 5 }, prompt: 'Read {ticket} "{title}". Plan first, then build it with tests. Stop and ask when the ticket is unclear.' },
]

export const STATUS: Record<RunStatus, [label: string, tone: string]> = {
  queued: ['Waiting', 'st-idle'],
  running: ['Running', 'st-run'],
  ok: ['Done', 'st-done'],
  failed: ['Failed', 'st-err'],
  overBudget: ['Over budget', 'st-err'],
  skipped: ['Skipped', 'warn'],
  cancelled: ['Cancelled', 'st-exit'],
}

export const CAUSE: Record<RunCause, string> = { schedule: 'On schedule', catchUp: 'Caught up after sleep', event: 'On event', webhook: 'On webhook', manual: 'Run now' }

/** "Today 9:00", "Yesterday 9:00", "Tomorrow 7:00", "Mon 7:00", "Oct 3 7:00"; local time */
export function whenLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY)
  const day =
    days === 0 ? 'Today' : days === -1 ? 'Yesterday' : days === 1 ? 'Tomorrow' : Math.abs(days) < 7 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${day} ${time}`
}

/** A routine row's status line from its newest run; tone is a CSS class */
export function lastRunText(run: RoutineRun | undefined, now = Date.now()): [text: string, tone: string] {
  if (!run) return ['Not run yet', '']
  const when = whenLabel(run.startedAt ?? run.dueAt, now)
  switch (run.status) {
    case 'queued':
      return ['Waiting for a free slot', 'st-idle']
    case 'running':
      return [`Running${run.detail ? ` · ${run.detail}` : ''}`, 'st-run']
    case 'skipped':
      return [`Missed ${when}: ${run.error ?? 'skipped'}`, 'warn']
    case 'failed':
    case 'overBudget':
      return [`Last run ${when}: ${run.error ?? STATUS[run.status][0]}`, 'st-err']
    default:
      return [`Last run ${when}: ${STATUS[run.status][0]}`, '']
  }
}

/** "14 turns · $0.62", empty for a run that never started */
export const runCost = (run: RoutineRun) => (run.startedAt === null ? '' : `${run.turns} turn${run.turns === 1 ? '' : 's'} · $${run.cost.toFixed(2)}`)

/** The budget fields: empty is no limit; garbage parses to NaN, which `problem` reports */
export const parseAmount = (text: string): number | null => (text.trim() ? Number(text.trim().replace(/^\$/, '')) : null)
