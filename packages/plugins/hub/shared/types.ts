import { isJson, isString } from '@treeix/shared/json'

export type Runtime = { kind: 'agent'; agent: string }

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

const isRuntime = (value: unknown): value is Runtime => isJson(value) && value.kind === 'agent' && isString(value.agent)

export const isHubAgent = (value: unknown): value is HubAgent =>
  isJson(value) &&
  ['id', 'name', 'icon', 'color', 'instructions'].every((key) => isString(value[key])) &&
  ['avatar', 'model', 'mode', 'folder'].every((key) => isNullableString(value[key])) &&
  isRuntime(value.runtime) &&
  typeof value.updatedAt === 'number'
