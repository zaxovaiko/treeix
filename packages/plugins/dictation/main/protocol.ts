import { isJson, list, parseJson, text } from '@treeix/shared/json'
import type { Hotkey, ModelState } from '../shared/types'

/** What the helper (`apps/desktop/native/voice`) prints, one JSON object per line */
export type HelperMessage =
  | { type: 'ready' }
  | { type: 'models'; models: ModelState[] }
  | { type: 'transcript'; id: number; text: string; app: string | null }
  | { type: 'error'; message: string }

/** What the helper reads on stdin */
export type HelperCommand =
  | { type: 'configure'; hotkey: Hotkey; tapToToggle: boolean; sounds: boolean; formatting: boolean; modelsPath: string; model: string }
  | { type: 'download' | 'delete'; model: string }
  | { type: 'insert'; id: number; text: string }

const STATES = new Set<unknown>(['missing', 'downloading', 'downloaded', 'loading', 'ready', 'error'] satisfies ModelState['state'][])

const isModelState = (value: unknown): value is ModelState =>
  isJson(value) &&
  typeof value.id === 'string' &&
  STATES.has(value.state) &&
  (value.progress === undefined || typeof value.progress === 'number') &&
  (value.error === undefined || typeof value.error === 'string')

/** A line from the helper, or null for anything else it or its libraries print */
export function parseHelperMessage(line: string): HelperMessage | null {
  const message = parseJson(line)
  if (!isJson(message)) return null
  switch (message.type) {
    case 'ready':
      return { type: 'ready' }
    case 'models':
      return { type: 'models', models: list(message.models, isModelState) }
    case 'transcript':
      if (typeof message.id !== 'number' || typeof message.text !== 'string') return null
      return { type: 'transcript', id: message.id, text: message.text, app: text(message.app) || null }
    case 'error':
      return { type: 'error', message: text(message.message) }
    default:
      return null
  }
}
