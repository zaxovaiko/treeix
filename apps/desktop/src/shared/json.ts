/** Guards for parsed JSON from disk, localStorage, CLIs and IPC */
export type Json = Record<string, unknown>

export const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
export const object = (value: unknown): Json => (isJson(value) ? value : {})
export const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const isString = (value: unknown): value is string => typeof value === 'string'

/** The items of an array that pass the guard (objects by default), or none when it isn't an array */
export function list(value: unknown): Json[]
export function list<T>(value: unknown, guard: (item: unknown) => item is T): T[]
export function list(value: unknown, guard: (item: unknown) => boolean = isJson): unknown[] {
  return Array.isArray(value) ? value.filter(guard) : []
}

/** Parsed JSON, or null when missing or malformed; callers narrow it */
export function parseJson(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? 'null')
  } catch {
    return null
  }
}

/** The string-valued entries of an object */
export const stringValues = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
