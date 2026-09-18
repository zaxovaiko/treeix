import { useEffect, useRef, useState } from 'react'
import type { Repo } from '@treeix/shared/types'
import { Icon } from '@treeix/app/Icon'
import { KindBadge, StatusDot, worktreeLabel } from '@treeix/app/sessionUi'
import { killSession, SESSION_KINDS, type Session, type SessionKind, setSessionListOpen, useTerminals } from './terminals'

/** Quick switcher for agent and shell sessions, opened from the title bar or ⌘⇧J */
export function SessionsDialog({
  sessions,
  repos,
  cwd,
  onPick,
  onNew,
  onClose
}: {
  sessions: Session[]
  repos: Repo[] | null
  /** Where new sessions start */
  cwd: string
  onPick: (session: Session) => void
  onNew: (kind: SessionKind) => void
  onClose: () => void
}): React.JSX.Element {
  const { panes, listOpen } = useTerminals()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const needle = query.trim().toLowerCase()
  // Sessions that need an answer come first
  const results = sessions
    .filter((session) => `${session.title} ${worktreeLabel(repos, session.worktreePath)} ${session.kind}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.status === 'input') - Number(a.status === 'input'))

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (session: Session | undefined): void => {
    if (!session) return
    onClose()
    onPick(session)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') setActive((active + 1) % Math.max(results.length, 1))
    else if (event.key === 'ArrowUp') setActive((active - 1 + results.length) % Math.max(results.length, 1))
    else if (event.key === 'Enter') pick(results[active])
    else if (event.key === 'Escape') onClose()
    else return
    event.preventDefault()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] pt-[12vh]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[64vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-2xl shadow-2xl shadow-black/60"
      >
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4 text-muted-foreground">
          <Icon name="terminal" className="size-4" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a session"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="rounded border border-border px-1.5 font-sans text-[10px]">esc</kbd>
        </label>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">{sessions.length ? 'No matching sessions' : 'No sessions yet, start one below'}</p>
          )}
          {results.map((session, index) => (
            <div
              key={session.id}
              data-index={index}
              role="button"
              tabIndex={-1}
              onMouseMove={() => setActive(index)}
              onClick={() => pick(session)}
              className={`group/row flex h-11 cursor-default items-center gap-3 rounded-md px-2.5 ${index === active ? 'bg-accent' : ''}`}
            >
              <KindBadge kind={session.kind} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] text-foreground">
                  {session.title}
                  {panes.includes(session.id) && <span className="ml-2 text-[11px] text-muted-foreground">shown</span>}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">{worktreeLabel(repos, session.worktreePath)}</span>
              </span>
              <StatusDot session={session} withLabel />
              <button
                title="End session"
                onClick={(event) => {
                  event.stopPropagation()
                  if (window.confirm(`End ${session.title}?`)) killSession(session.id)
                }}
                className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-accent hover:text-red-400"
              >
                <Icon name="power" className="size-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-border px-2.5 text-[11px] text-muted-foreground">
          <span className="mr-1 truncate">New in {worktreeLabel(repos, cwd)}</span>
          {(Object.keys(SESSION_KINDS) as SessionKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => {
                onClose()
                onNew(kind)
              }}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-foreground ring-1 ring-border hover:bg-accent"
            >
              <KindBadge kind={kind} />
              {SESSION_KINDS[kind].label}
            </button>
          ))}
          <span className="flex-1" />
          <button onClick={() => setSessionListOpen(!listOpen)} className="h-7 rounded-md px-2 hover:bg-accent hover:text-foreground">
            {listOpen ? 'Hide' : 'Show'} session list
          </button>
        </div>
      </div>
    </div>
  )
}
