import type { ConsoleEntry, NetworkEntry } from '../shared/types'

export const ENTRY_LIMIT = 500

export const keepLast = <T>(list: T[], item: T, limit = ENTRY_LIMIT): T[] => [...list, item].slice(-limit)

// CDP events come from the page's process, so every field is read defensively
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).flatMap(([key, entry]) => (typeof entry === 'string' ? [[key, entry]] : [])))

const LEVELS: Record<string, ConsoleEntry['level']> = { error: 'error', assert: 'error', warning: 'warning', info: 'info', debug: 'debug' }
const fileOf = (url: string): string => url.split(/[?#]/)[0].split('/').at(-1) ?? url

let counter = 0
const nextId = (): string => `e${++counter}`

function frames(stackTrace: unknown): { source: string; stack: string } {
  const calls = list(record(stackTrace).callFrames).map(record)
  const top = calls[0]
  const at = (frame: Record<string, unknown>): string => `${text(frame.url)}:${(number(frame.lineNumber) ?? 0) + 1}:${(number(frame.columnNumber) ?? 0) + 1}`
  return {
    source: top ? `${fileOf(text(top.url))}:${(number(top.lineNumber) ?? 0) + 1}` : '',
    stack: calls.map((frame) => `at ${text(frame.functionName) || '(anonymous)'} (${at(frame)})`).join('\n')
  }
}

export function consoleFromApi(params: unknown): ConsoleEntry | null {
  const event = record(params)
  if (typeof event.type !== 'string' || !Array.isArray(event.args)) return null
  const args = list(event.args).map(record).map((arg) => (arg.value !== undefined ? String(arg.value) : text(arg.description) || text(arg.type)))
  return { kind: 'console', id: nextId(), level: LEVELS[event.type] ?? 'log', text: args.join(' '), ...frames(event.stackTrace), time: number(event.timestamp) ?? Date.now() }
}

export function consoleFromException(params: unknown): ConsoleEntry | null {
  const details = record(record(params).exceptionDetails)
  if (!Object.keys(details).length) return null
  const description = text(record(details.exception).description) || text(details.text)
  const url = text(details.url)
  return {
    kind: 'console',
    id: nextId(),
    level: 'error',
    text: description.split('\n')[0],
    source: url ? `${fileOf(url)}:${(number(details.lineNumber) ?? 0) + 1}` : '',
    stack: description,
    time: number(record(params).timestamp) ?? Date.now()
  }
}

/** Folds one Network domain event into its request; returns the request when it changed */
export function applyNetworkEvent(requests: Map<string, NetworkEntry>, method: string, params: unknown): NetworkEntry | null {
  const event = record(params)
  const id = text(event.requestId)
  if (method === 'Network.requestWillBeSent') {
    const request = record(event.request)
    const entry: NetworkEntry = {
      kind: 'network',
      id,
      method: text(request.method),
      url: text(request.url),
      resourceType: text(event.type),
      status: null,
      failed: null,
      mimeType: '',
      startedAt: number(event.timestamp) ?? 0,
      durationMs: null,
      requestHeaders: stringMap(request.headers),
      responseHeaders: {},
      postData: typeof request.postData === 'string' ? request.postData : null
    }
    requests.set(id, entry)
    return entry
  }
  const current = requests.get(id)
  if (!current) return null
  const finishedAt = number(event.timestamp)
  const duration = finishedAt === null ? current.durationMs : Math.round((finishedAt - current.startedAt) * 1000)
  const next: NetworkEntry =
    method === 'Network.responseReceived'
      ? { ...current, status: number(record(event.response).status), responseHeaders: stringMap(record(event.response).headers), mimeType: text(record(event.response).mimeType) }
      : method === 'Network.loadingFinished'
        ? { ...current, durationMs: duration }
        : method === 'Network.loadingFailed'
          ? { ...current, durationMs: duration, failed: text(event.errorText) || 'failed' }
          : current
  requests.set(id, next)
  return next
}
