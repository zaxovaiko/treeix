import { useEffect, useState } from 'react'
import { PageLayout, PANE_HEADER, useHost, useListNav } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { EmptyState, errorMessage } from '@treeix/app/ui'
import type { CalendarEvent, Meeting, MeetingDetail, MeetingStatus, Rule } from '../shared/types'
import { bridge, button, meetingsSettings, revision, status } from './state'

const ROW = 'mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent'
const DOT: Record<MeetingStatus, string> = { recording: 'bg-red-400', transcribing: 'bg-amber-400', done: '', failed: 'bg-red-400/60' }
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (iso: string): string => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })

const willRecord = (rules: Rule[], url: string | null): boolean =>
  url !== null &&
  rules.some((rule) => {
    try {
      return rule.url !== '' && new RegExp(rule.url).test(url)
    } catch {
      return false
    }
  })

/** Today's calendar events with a link, still to come or under way */
function Upcoming(): React.JSX.Element | null {
  const { auto, calendar, rules } = meetingsSettings.use()
  const running = status.use()?.helper === 'running'
  const [events, setEvents] = useState<CalendarEvent[]>([])
  useEffect(() => {
    if (!calendar || !running) return setEvents([])
    const read = (): void => {
      const now = new Date()
      const end = new Date(now)
      end.setHours(23, 59, 59)
      void bridge.invoke<CalendarEvent[]>('events', now.toISOString(), end.toISOString()).then((found) => setEvents(found.filter((event) => event.url)))
    }
    read()
    const timer = setInterval(read, 5 * 60_000)
    return () => clearInterval(timer)
  }, [calendar, running])
  if (!events.length) return null
  return (
    <div className="border-b border-border pb-1.5">
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">Upcoming</div>
      {events.map((event) => (
        <div key={`${event.start} ${event.title}`} className="mx-1.5 flex items-center gap-2 rounded-md px-2 py-1">
          <span className="w-10 shrink-0 text-[11px] text-muted-foreground tabular-nums">{time(event.start)}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{event.title}</span>
          {auto && willRecord(rules, event.url) && <span className="shrink-0 rounded bg-red-400/12 px-1 text-[10px] text-red-400">will record</span>}
          {event.url && (
            <button className="shrink-0 rounded-md px-1.5 text-[11px] text-primary hover:bg-accent" onClick={() => void bridge.invoke('join', event.url)}>
              Join
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function MeetingView({ id }: { id: string }): React.JSX.Element {
  const host = useHost()
  const version = revision.use()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  useEffect(() => void bridge.invoke<MeetingDetail>('detail', id).then(setMeeting, () => setMeeting(null)), [id, version])
  if (!meeting) return <EmptyState fill title="Loading..." />
  const act = (channel: string, done: string): void =>
    void bridge.invoke<unknown>(channel, id).then(
      (result) => host.flash(result === false ? 'No AI Hub workflow starts on meetings.transcribed' : done),
      (reason: unknown) => host.flash(errorMessage(reason))
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`${PANE_HEADER} gap-2 px-4`}>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{meeting.title}</span>
        {meeting.status === 'failed' && (
          <button className={button} onClick={() => act('transcribe', 'Transcribing again')}>
            Transcribe again
          </button>
        )}
        {meeting.status === 'done' && (
          <button
            className={button}
            title="Hands the transcript to the workflows that start on meetings.transcribed"
            onClick={() => window.confirm('Run the workflows again? Anything they create, such as Notion pages, may be created twice.') && act('rerun', 'Workflows started')}
          >
            Run workflows again
          </button>
        )}
        <button
          className={button}
          disabled={meeting.status === 'recording'}
          onClick={() => window.confirm(`Delete ${meeting.title} with its audio, transcript and notes?`) && act('remove', 'Deleted')}
        >
          Delete
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p className="mb-4 text-xs text-muted-foreground">
          {day(meeting.start)}, {time(meeting.start)}
          {meeting.end && `-${time(meeting.end)}`}
          {meeting.app && ` · ${meeting.app}`}
          {meeting.invitees.length > 0 && ` · ${meeting.invitees.join(', ')}`}
        </p>
        {meeting.error && <p className="mb-4 text-xs text-red-400">{meeting.error}</p>}
        {meeting.status === 'recording' && <EmptyState icon="mic" title="Recording. The transcript appears once the call ends." />}
        {meeting.status === 'transcribing' && <EmptyState icon="loader" title="Transcribing..." />}
        {meeting.notes && (
          <section className="mb-6">
            <h2 className="mb-2 text-[11px] font-semibold text-muted-foreground">Notes</h2>
            <LazyMarkdown>{meeting.notes}</LazyMarkdown>
          </section>
        )}
        {meeting.transcript && <LazyMarkdown>{meeting.transcript.replace(/^# .*\n+/, '')}</LazyMarkdown>}
      </div>
    </div>
  )
}

export function MeetingsTab(): React.JSX.Element {
  const version = revision.use()
  const helper = status.use()?.helper
  const [query, setQuery] = useState('')
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => void bridge.invoke<Meeting[]>('meetings', query).then(setMeetings), query ? 200 : 0)
    return () => clearTimeout(timer)
  }, [query, version])
  const current = meetings.find((meeting) => meeting.id === selected) ?? meetings[0] ?? null
  const nav = useListNav({ count: meetings.length, index: current ? meetings.indexOf(current) : -1, onSelect: (index) => setSelected(meetings[index].id) })

  const list = (
    <>
      <div className={`${PANE_HEADER} pl-3`}>
        <span className="text-[11px] font-semibold">Meetings</span>
      </div>
      <div className="shrink-0 border-b border-border p-2">
        <label className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground ring-1 ring-border">
          <Icon name="search" className="size-3.5" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles and transcripts"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <Upcoming />
        {meetings.length === 0 && <EmptyState title={query ? 'Nothing matches' : 'No meetings recorded yet'} />}
        {meetings.map((meeting, index) => (
          <button key={meeting.id} {...nav.rowProps(index)} onClick={() => setSelected(meeting.id)} className={`${ROW} ${meeting === current ? 'bg-accent' : ''}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{meeting.title}</span>
              <span className="block text-[11px] text-muted-foreground">
                {day(meeting.start)}, {time(meeting.start)}
              </span>
            </span>
            {DOT[meeting.status] && <span title={meeting.status} className={`size-1.5 shrink-0 rounded-full ${DOT[meeting.status]}`} />}
          </button>
        ))}
      </div>
    </>
  )

  const problem =
    helper === 'unsupported'
      ? 'Recording needs an Apple silicon Mac on macOS 14 or later.'
      : helper === 'missing'
        ? 'The meetings helper is not built. Run `bun run build:voice` in apps/desktop.'
        : null
  const main = current ? <MeetingView key={current.id} id={current.id} /> : <EmptyState fill icon="mic" title={problem ?? 'Calls you join are recorded and transcribed here.'} />
  return <PageLayout listWidth={260} list={list} main={main} />
}
