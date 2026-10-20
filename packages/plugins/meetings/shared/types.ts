import { isJson, isString, type Json, list, text } from '@treeix/shared/json'

/**
 * A call to record: an app whose bundle id starts with `app` uses the microphone and, when `url` is set, Google Chrome has a
 * tab whose address matches it as a regular expression. The matched part tells one call from the next.
 */
export type Rule = { name: string; app: string; url: string }

// Meet also opens calls at /meet/<code>; the old pattern missed those, so stored copies of it are upgraded
const MEET_URL = '^https://meet\\.google\\.com/(?:[a-z]+/)?[a-z]{3}-[a-z]{4}-[a-z]{3}'
const OLD_MEET_URL = '^https://meet\\.google\\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}'

export const DEFAULT_RULES: Rule[] = [
  { name: 'Google Meet', app: 'com.google.Chrome', url: MEET_URL },
  { name: 'Slack huddle', app: 'com.tinyspeck.slackmacgap', url: '' },
  { name: 'Slack huddle', app: 'com.google.Chrome', url: '^https://app\\.slack\\.com/' },
  { name: 'Zoom', app: 'us.zoom.xos', url: '' },
  { name: 'Microsoft Teams', app: 'com.microsoft.teams2', url: '' }
]

export const START_DELAYS = [3, 10, 30] as const
export const STOP_DELAYS = [10, 20, 60] as const

/** Parakeet v3's languages; the hint keeps words to that language's alphabet */
export const LANGUAGES = [
  ['', 'Detect'],
  ['en', 'English'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
  ['ru', 'Russian'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['cs', 'Czech'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['hr', 'Croatian'],
  ['bs', 'Bosnian'],
  ['sr', 'Serbian'],
  ['bg', 'Bulgarian'],
  ['be', 'Belarusian'],
  ['ro', 'Romanian'],
  ['hu', 'Hungarian'],
  ['da', 'Danish'],
  ['sv', 'Swedish'],
  ['fi', 'Finnish'],
  ['et', 'Estonian'],
  ['lv', 'Latvian'],
  ['lt', 'Lithuanian'],
  ['mt', 'Maltese'],
  ['el', 'Greek']
] as const
export type Language = (typeof LANGUAGES)[number][0]

export type MeetingsSettings = {
  /** Records on its own when a rule matches; off, only the Start command does */
  auto: boolean
  rules: Rule[]
  startDelaySec: (typeof START_DELAYS)[number]
  stopDelaySec: (typeof STOP_DELAYS)[number]
  /** Names the meeting and lists invitees from the calendar event it falls in */
  calendar: boolean
  /** Where meeting folders go; empty is `<plugin data>/meetings` */
  folder: string
  /** What the calls are spoken in; empty lets the model detect it */
  language: Language
}

const isRule = (value: unknown): value is Rule => isJson(value) && isString(value.name) && isString(value.app) && isString(value.url)

export const parseSettings = (stored: Json): MeetingsSettings => ({
  auto: stored.auto !== false,
  rules: Array.isArray(stored.rules) ? list(stored.rules, isRule).map((rule) => (rule.url === OLD_MEET_URL ? { ...rule, url: MEET_URL } : rule)) : DEFAULT_RULES,
  startDelaySec: START_DELAYS.find((seconds) => seconds === stored.startDelaySec) ?? 3,
  stopDelaySec: STOP_DELAYS.find((seconds) => seconds === stored.stopDelaySec) ?? 20,
  calendar: stored.calendar !== false,
  folder: text(stored.folder),
  language: LANGUAGES.find(([code]) => code === stored.language)?.[0] ?? ''
})

export type MeetingStatus = 'recording' | 'transcribing' | 'done' | 'failed'

/** meeting.json in the meeting's folder; the folder name is the id */
export type Meeting = {
  id: string
  title: string
  /** ISO times */
  start: string
  end: string | null
  /** The rule's name, such as Google Meet */
  app: string
  url: string | null
  invitees: string[]
  status: MeetingStatus
  error?: string
}

export type MeetingDetail = Meeting & { transcript: string; notes: string }

/** A calendar event, for the Upcoming list */
export type CalendarEvent = { title: string; start: string; end: string; url: string | null; invitees: string[] }

export type Status = {
  /** `missing`: the helper binary isn't built; `unsupported`: not an Apple silicon Mac on macOS 14 or later */
  helper: 'starting' | 'running' | 'missing' | 'crashed' | 'unsupported'
  recording: { id: string; title: string; since: number } | null
  /** The last thing that went wrong, for Settings */
  error: string | null
  /** Why a call looks on while nothing records, so a missed recording shows */
  unrecorded: string | null
}

export type Permissions = { microphone: string; calendar: string }

/** Elapsed time as m:ss */
export const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The list heading a meeting falls under: Today, Yesterday, N days ago within a week, This month, then the month itself */
export function dayGroup(at: Date, now = new Date()): string {
  const midnight = (date: Date): number => new Date(date).setHours(0, 0, 0, 0)
  const days = Math.round((midnight(now) - midnight(at)) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const thisYear = at.getFullYear() === now.getFullYear()
  if (thisYear && at.getMonth() === now.getMonth()) return 'This month'
  return at.toLocaleDateString([], thisYear ? { month: 'long' } : { month: 'long', year: 'numeric' })
}
