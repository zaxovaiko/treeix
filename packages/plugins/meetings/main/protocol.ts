import { isJson, isString, list, parseJson, text } from '@treeix/shared/json'
import type { CalendarEvent } from '../shared/types'
import { isUtterance, type Utterance } from './store'

/** What the helper (`treeix-meetings` in `apps/desktop/native/voice`) prints, one JSON object per line */
export type HelperMessage =
  | { type: 'ready' }
  /** Bundle ids of the processes using the microphone, sent whenever they change */
  | { type: 'mic'; apps: string[] }
  | { type: 'recording'; folder: string }
  | { type: 'stopped'; folder: string }
  | { type: 'transcript'; folder: string; utterances: Utterance[] }
  /** The event the meeting falls in, null when none */
  | { type: 'calendar'; event: CalendarEvent | null }
  | { type: 'events'; events: CalendarEvent[] }
  | { type: 'calendarAccess'; status: string }
  /** `folder` when it concerns one meeting's recording or transcript */
  | { type: 'error'; message: string; folder: string | null }

/** What the helper reads on stdin */
export type HelperCommand =
  | { type: 'configure'; modelsPath: string }
  /** Records the microphone to me.caf and what `app` plays to others.caf; an empty app records the microphone alone */
  | { type: 'record'; folder: string; app: string }
  | { type: 'stop' }
  /** Diarized transcript of the folder's audio; `keepAudio` mixes it into meeting.m4a, otherwise the audio is deleted */
  | { type: 'transcribe'; folder: string; keepAudio: boolean }
  /** The event at `at` (ISO) whose link contains `url`, else one in progress with invitees */
  | { type: 'calendar'; at: string; url: string | null }
  | { type: 'events'; from: string; to: string }
  /** Asks for calendar access, or reports it when already decided */
  | { type: 'calendarAccess' }

const isEvent = (value: unknown): value is CalendarEvent =>
  isJson(value) &&
  isString(value.title) &&
  isString(value.start) &&
  isString(value.end) &&
  (value.url === null || isString(value.url)) &&
  Array.isArray(value.invitees) &&
  value.invitees.every(isString)

/** A line from the helper, or null for anything else it or its libraries print */
export function parseHelperMessage(line: string): HelperMessage | null {
  const message = parseJson(line)
  if (!isJson(message)) return null
  switch (message.type) {
    case 'ready':
      return { type: 'ready' }
    case 'mic':
      return { type: 'mic', apps: list(message.apps, isString) }
    case 'recording':
    case 'stopped':
      return { type: message.type, folder: text(message.folder) }
    case 'transcript':
      return { type: 'transcript', folder: text(message.folder), utterances: list(message.utterances, isUtterance) }
    case 'calendar':
      return { type: 'calendar', event: isEvent(message.event) ? message.event : null }
    case 'events':
      return { type: 'events', events: list(message.events, isEvent) }
    case 'calendarAccess':
      return { type: 'calendarAccess', status: text(message.status) }
    case 'error':
      return { type: 'error', message: text(message.message), folder: text(message.folder) || null }
    default:
      return null
  }
}
