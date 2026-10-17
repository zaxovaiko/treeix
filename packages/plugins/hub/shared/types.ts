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
  color: string
  runtime: Runtime
  /** A model the runtime offers; null keeps its default */
  model: string | null
  instructions: string
  /** Where it works; null is the selected worktree */
  folder: string | null
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
  ['model', 'folder'].every((key) => isNullableString(value[key])) &&
  isRuntime(value.runtime) &&
  (value.autoApprove === undefined || typeof value.autoApprove === 'boolean') &&
  (value.schedules === undefined || (Array.isArray(value.schedules) && value.schedules.every(isSchedule))) &&
  typeof value.updatedAt === 'number'

/** Remote access as Settings shows it: `enableUrl` is the admin page that turns Serve on for the tailnet, while the CLI waits on it */
export type RemoteStatus = { on: boolean; url: string | null; enableUrl: string | null; error: string | null; devices: number }

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

export const isRemoteStatus = (value: unknown): value is RemoteStatus =>
  isJson(value) && typeof value.on === 'boolean' && nullableString(value.url) && nullableString(value.enableUrl) && nullableString(value.error) && typeof value.devices === 'number'

/** When nobody answers a waiting step in time, its agent decides after `afterMin` (null waits forever); `ticket` also asks on the run's ticket */
export type DecisionSettings = { afterMin: number | null; ticket: boolean }

export const DECISION_DEFAULTS: DecisionSettings = { afterMin: 60, ticket: true }

export const toDecisionSettings = (value: unknown): DecisionSettings =>
  isJson(value)
    ? {
        afterMin: typeof value.afterMin === 'number' && value.afterMin > 0 ? value.afterMin : value.afterMin === null ? null : DECISION_DEFAULTS.afterMin,
        ticket: value.ticket !== false
      }
    : DECISION_DEFAULTS
