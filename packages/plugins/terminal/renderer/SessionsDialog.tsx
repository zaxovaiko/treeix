import { useEffect, useRef, useState } from 'react'
import type { Repo } from '@treeix/shared/types'
import { Icon } from '@treeix/app/Icon'
import { KindBadge, StatusDot, worktreeLabel } from '@treeix/app/sessionUi'
import { timeAgo } from '@treeix/app/time'
import { Keys } from '@treeix/sdk'
import { type Task, taskOf } from './tasks'
import { taskLabel } from './taskUi'
import { type ClosedSession, forgetClosedSession, killSession, searchTranscripts, type Session, sessionUsage, transcriptRef } from './terminals'
import type { SessionUsage } from '../shared/types'

/** Shorter queries match too many conversations to be useful, and each search reads every transcript */
const CONTENT_QUERY_MIN = 3
const CONTENT_SEARCH_DELAY_MS = 300

const tokens = (count: number): string => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : `${count}`)

/** "1.2M in · 34k out · 3.1M cached · $3.40" */
export const usageLabel = ({ input, output, cached, costUsd }: SessionUsage): string =>
  [`${tokens(input)} in`, `${tokens(output)} out`, cached > 0 && `${tokens(cached)} cached`, costUsd !== undefined && `$${costUsd.toFixed(2)}`].filter(Boolean).join(' · ')

const GROUPS = [
  ['input', 'Needs input'],
  ['running', 'Working'],
  ['idle', 'Idle'],
  ['closed', 'Recently closed']
] as const

type Row = { group: (typeof GROUPS)[number][0]; label: string; detail: string; session?: Session; entry?: ClosedSession }

/** Quick switcher for sessions of the workspace, grouped by what they need; `closed` lists only recently closed ones */
export function SessionsDialog({
  sessions,
  history,
  tasks,
  repos,
  mode,
  onPick,
  onRestore,
  onClose
}: {
  sessions: Session[]
  /** Newest first */
  history: ClosedSession[]
  tasks: Task[]
  repos: Repo[] | null
  mode: 'all' | 'closed'
  onPick: (session: Session) => void
  onRestore: (entry: ClosedSession) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const where = (item: { worktreePath: string }, task: Task | undefined): string => (task ? taskLabel(task, repos) : worktreeLabel(repos, item.worktreePath))
  const live: Row[] = mode === 'closed' ? [] : sessions.map((session) => ({ group: session.status === 'exited' || session.status === 'dormant' ? 'idle' : session.status, label: session.title, detail: where(session, taskOf(tasks, session.id)), session }))
  const closed: Row[] = history.map((entry) => ({
    group: 'closed',
    label: entry.title,
    detail: `${where(entry, tasks.find((task) => task.id === entry.taskId))} · ${timeAgo(new Date(entry.endedAt).toISOString())}`,
    entry
  }))
  const needle = query.trim().toLowerCase()
  const [contentHits, setContentHits] = useState<Set<string>>(new Set())
  const [usage, setUsage] = useState<{ id: string; usage: SessionUsage | null } | null>(null)
  const idOf = (row: Row): string => row.session?.id ?? row.entry?.id ?? ''
  const titleMatch = (row: Row): boolean => `${row.label} ${row.detail}`.toLowerCase().includes(needle)
  const rows = GROUPS.flatMap(([group]) => [...live, ...closed].filter((row) => row.group === group && (titleMatch(row) || contentHits.has(idOf(row)))))
  const current = Math.min(active, rows.length - 1)
  const shown = rows[current]
  const shownRef = shown ? transcriptRef(shown.session ?? shown.entry) : null

  // Conversations are searched once typing pauses; a newer query drops the older answer
  useEffect(() => {
    if (needle.length < CONTENT_QUERY_MIN) return setContentHits(new Set())
    let stale = false
    const refs = [...live, ...closed].flatMap((row) => transcriptRef(row.session ?? row.entry) ?? [])
    const timer = setTimeout(() => void searchTranscripts(needle, refs).then((ids) => stale || setContentHits(new Set(ids))), CONTENT_SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [needle])
  useEffect(() => {
    if (!shownRef) return setUsage(null)
    let stale = false
    void sessionUsage(shownRef).then((result) => stale || setUsage({ id: shownRef.sessionId, usage: result }))
    return () => {
      stale = true
    }
  }, [shownRef?.sessionId])

  // Closing puts focus back where it was; a picked session takes it right after
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => previous?.focus({ preventScroll: true })
  }, [])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pick = (row: Row | undefined): void => {
    if (!row) return
    onClose()
    if (row.session) onPick(row.session)
    else if (row.entry) onRestore(row.entry)
  }
  const remove = (row: Row | undefined): void => {
    if (row?.session) killSession(row.session.id)
    else if (row?.entry) forgetClosedSession(row.entry.id)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') setActive((current + 1) % Math.max(rows.length, 1))
    else if (event.key === 'ArrowUp') setActive((current - 1 + rows.length) % Math.max(rows.length, 1))
    else if (event.key === 'Enter') pick(rows[current])
    else if (event.key === 'Escape') onClose()
    else if (event.key === 'Backspace' && event.metaKey) remove(rows[current])
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/45 pt-[11vh]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[72vh] w-[660px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-input bg-popover shadow-2xl shadow-black/60">
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4 text-muted-foreground">
          <Icon name="search" className="size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'closed' ? 'Reopen a closed session, or search its conversation' : 'Find a session by title, group or conversation'}
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <Keys combo="esc" hint />
        </label>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{needle ? 'No matching sessions' : 'No sessions'}</p>}
          {rows.map((row, index) => (
            <div key={row.session?.id ?? row.entry?.id}>
              {row.group !== rows[index - 1]?.group && (
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{GROUPS.find(([group]) => group === row.group)?.[1]}</div>
              )}
              <div
                data-active={index === current ? '' : undefined}
                role="option"
                aria-selected={index === current}
                onMouseMove={() => setActive(index)}
                onClick={() => pick(row)}
                className={`group/row flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] ${index === current ? 'bg-foreground/10 text-foreground' : 'text-foreground/85'}`}
              >
                {row.session ? <KindBadge kind={row.session.kind} /> : row.entry && <KindBadge kind={row.entry.kind} />}
                {row.session && <StatusDot session={row.session} />}
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{row.detail}</span>
                {!titleMatch(row) && <span className="shrink-0 text-[11px] text-muted-foreground/70">in conversation</span>}
                <span className="flex-1" />
                <button
                  title={row.session ? 'Close session to History (⌘⌫)' : 'Remove from History (⌘⌫)'}
                  aria-label={row.session ? 'Close session' : 'Remove from history'}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    remove(row)
                  }}
                  className={`grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-red-400 ${index === current ? '' : 'opacity-0 group-hover/row:opacity-100'}`}
                >
                  <Icon name={row.session ? 'power' : 'trash'} className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t border-border px-3 text-[11px] text-muted-foreground">
          <span className="truncate">Closed sessions reopen as a new tab of their group</span>
          <span className="flex-1" />
          {shownRef && usage?.id === shownRef.sessionId && usage.usage && <span className="shrink-0 tabular-nums">{usageLabel(usage.usage)}</span>}
        </div>
      </div>
    </div>
  )
}
