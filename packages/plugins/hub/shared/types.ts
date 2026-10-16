import { isJson, isString } from '@treeix/shared/json'
import { isCron } from './cron'

/** An agent from the registry (Claude, Codex, the user's own), or an OpenAI-compatible API by base URL */
export type Runtime = { kind: 'agent'; agent: string } | { kind: 'api'; baseUrl: string }

/** APIs offered by name; any other OpenAI-compatible URL works too */
export const API_PRESETS = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' }
] as const

/**
 * A prompt the agent gets on a crontab schedule while Treeix runs; `notify` shows its answer as a notification.
 * With a `command`, each firing runs it instead, and every line it prints starts its own run (see `commandItems`).
 */
export type Schedule = {
  id: string
  cron: string
  prompt: string
  notify: boolean
  enabled: boolean
  command?: string
  /** Minutes each run may take, `ASK_TIMEOUT_MIN` when unset */
  timeoutMin?: number
}

export const MAX_TIMEOUT_MIN = 600

export const isTimeout = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MIN

/** A command schedule's output as the runs it starts: one per line, `<input>` or `<input>\t<title>`; the prompt gets `<input>` as `{{input}}` */
export const commandItems = (stdout: string): { input: string; title: string }[] =>
  stdout.split('\n').flatMap((line) => {
    const [input = '', ...title] = line.split('\t').map((part) => part.trim())
    return input ? [{ input, title: [input, ...title].join(' ').trim() }] : []
  })

/** An agent of the user's own: a persona on top of a runtime from the agent registry */
export type HubAgent = {
  id: string
  name: string
  /** One glyph, shown on tabs and badges */
  icon: string
  /** A small square image as a data URL; the glyph on the color when null */
  avatar: string | null
  color: string
  runtime: Runtime
  /** Option values the runtime offers; null keeps its default */
  model: string | null
  mode: string | null
  instructions: string
  /** Where it works; null is the selected worktree */
  folder: string | null
  /** More folders it loads beside `folder`: their instructions, skills and subagents */
  directories?: string[]
  /** Allows every permission it asks for in runs, so they never wait; missing on agents saved before it existed */
  autoApprove?: boolean
  /** Missing on agents saved before schedules existed */
  schedules?: Schedule[]
  updatedAt: number
}

/** Registry ids of hub agents, so they never clash with the user's own */
export const AGENT_PREFIX = 'hub.'

const isNullableString = (value: unknown): value is string | null => value === null || isString(value)

const isRuntime = (value: unknown): value is Runtime => isJson(value) && ((value.kind === 'agent' && isString(value.agent)) || (value.kind === 'api' && isString(value.baseUrl)))

export const isSchedule = (value: unknown): value is Schedule =>
  isJson(value) &&
  isString(value.id) &&
  isString(value.cron) &&
  isCron(value.cron) &&
  isString(value.prompt) &&
  typeof value.notify === 'boolean' &&
  typeof value.enabled === 'boolean' &&
  (value.command === undefined || isString(value.command)) &&
  (value.timeoutMin === undefined || isTimeout(value.timeoutMin))

export const isHubAgent = (value: unknown): value is HubAgent =>
  isJson(value) &&
  ['id', 'name', 'icon', 'color', 'instructions'].every((key) => isString(value[key])) &&
  ['avatar', 'model', 'mode', 'folder'].every((key) => isNullableString(value[key])) &&
  isRuntime(value.runtime) &&
  (value.directories === undefined || (Array.isArray(value.directories) && value.directories.every(isString))) &&
  (value.autoApprove === undefined || typeof value.autoApprove === 'boolean') &&
  (value.schedules === undefined || (Array.isArray(value.schedules) && value.schedules.every(isSchedule))) &&
  typeof value.updatedAt === 'number'

const TICKET_STATUSES = ['running', 'mr', 'question', 'hold', 'failed', 'stopped'] as const
/** A run of the launchd ticket runner (~/.claude/ticket-runner), as its runs/<item>.json says */
export type TicketRun = {
  item: string
  title: string
  project: string
  cwd: string
  sessionId: string
  status: (typeof TICKET_STATUSES)[number]
  startedAt: number
  endedAt: number | null
  cost: number | null
  url: string | null
  error: string | null
}

const isNullableNumber = (value: unknown): value is number | null => value === null || typeof value === 'number'
export const isTicketRun = (value: unknown): value is TicketRun =>
  isJson(value) &&
  ['item', 'title', 'project', 'cwd'].every((key) => isString(value[key])) &&
  // It goes into a `claude --resume` command line
  isString(value.sessionId) &&
  /^[0-9a-f-]{36}$/.test(value.sessionId) &&
  TICKET_STATUSES.some((status) => status === value.status) &&
  typeof value.startedAt === 'number' &&
  isNullableNumber(value.endedAt) &&
  isNullableNumber(value.cost) &&
  isNullableString(value.url) &&
  isNullableString(value.error)
