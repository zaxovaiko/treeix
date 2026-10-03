import { isJson, isString } from '@treeix/shared/json'

/** An agent from the registry (Claude, Codex, the user's own), or an OpenAI-compatible API by base URL */
export type Runtime = { kind: 'agent'; agent: string } | { kind: 'api'; baseUrl: string }

/** APIs offered by name; any other OpenAI-compatible URL works too */
export const API_PRESETS = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' }
] as const

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
  updatedAt: number
}

/** Registry ids of hub agents, so they never clash with the user's own */
export const AGENT_PREFIX = 'hub.'

const isNullableString = (value: unknown): value is string | null => value === null || isString(value)

const isRuntime = (value: unknown): value is Runtime =>
  isJson(value) && ((value.kind === 'agent' && isString(value.agent)) || (value.kind === 'api' && isString(value.baseUrl)))

export const isHubAgent = (value: unknown): value is HubAgent =>
  isJson(value) &&
  ['id', 'name', 'icon', 'color', 'instructions'].every((key) => isString(value[key])) &&
  ['avatar', 'model', 'mode', 'folder'].every((key) => isNullableString(value[key])) &&
  isRuntime(value.runtime) &&
  typeof value.updatedAt === 'number'
