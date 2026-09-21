import { useMemo, useSyncExternalStore } from 'react'
import { type SessionPort, type SessionSummary, useHost } from '@treeix/sdk'
import type { Repo } from '@treeix/shared/types'
import { worktreeLabel } from '@treeix/app/sessionUi'
import { useRecent } from './recent'
import { browserSettings } from './settings'

export type Suggestion = { url: string; label: string; detail: string }
export type SuggestionSection = { title: string; items: Suggestion[] }

const COMMON_PORTS = [3000, 5173, 8080, 4200, 8000, 5000, 3001, 8787]
const RECENT_SHOWN = 6
const NO_PORTS: SessionPort[] = []
const NO_SESSIONS: SessionSummary[] = []
const noSubscribe = (): (() => void) => () => undefined

const withoutScheme = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** "<session title> · <worktree>" for the session listening on a port */
export function sessionDetail(sessions: SessionSummary[], repos: Repo[] | null, sessionId: string): string {
  const session = sessions.find((candidate) => candidate.id === sessionId)
  return session ? `${session.title} · ${worktreeLabel(repos, session.worktreePath)}` : ''
}

/** Servers started by sessions, as suggestions */
export function useRunning(): Suggestion[] {
  const host = useHost()
  const service = host.service('sessions')
  const ports = useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.getPorts ?? (() => NO_PORTS))
  // Titles and worktrees come from the sessions
  const sessions = useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.getSessions ?? (() => NO_SESSIONS))
  return useMemo(() => ports.map(({ port, url, sessionId }) => ({ url, label: `localhost:${port}`, detail: sessionDetail(sessions, host.repos, sessionId) })), [ports, sessions, host.repos])
}

export function useSuggestions(query: string): SuggestionSection[] {
  const running = useRunning()
  const recent = useRecent()
  const { saved } = browserSettings.use()
  return useMemo(() => {
    const text = query.trim().toLowerCase()
    const matches = ({ url, label, detail }: Suggestion): boolean => !text || [url, label, detail].some((value) => value.toLowerCase().includes(text))
    const runningPorts = new Set(running.map((item) => item.label))
    const common = COMMON_PORTS.map((port) => `localhost:${port}`)
      .filter((label) => !runningPorts.has(label))
      .map((label) => ({ url: `http://${label}`, label, detail: '' }))
    const sections: SuggestionSection[] = [
      { title: 'Running now', items: running.filter(matches) },
      { title: 'Recent', items: recent.map(({ url, title }) => ({ url, label: withoutScheme(url), detail: title })).filter(matches).slice(0, RECENT_SHOWN) },
      { title: 'Saved', items: saved.map(({ name, url }) => ({ url, label: name, detail: withoutScheme(url) })).filter(matches) },
      { title: 'Common', items: common.filter(matches) }
    ]
    return sections.filter((section) => section.items.length > 0)
  }, [query, running, recent, saved])
}

/** A row that opens its address on click; `onMouseDown` keeps the address bar's focus until then */
export function SuggestionRow({ item, active, onOpen, onHover }: { item: Suggestion; active: boolean; onOpen: (url: string) => void; onHover?: () => void }): React.JSX.Element {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(item.url)}
      onMouseMove={onHover}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-xs ${active ? 'bg-accent text-foreground' : 'text-foreground/90 hover:bg-accent/60'}`}
    >
      <span className="shrink-0 font-mono">{item.label}</span>
      {item.detail && <span className="min-w-0 truncate text-muted-foreground">{item.detail}</span>}
    </button>
  )
}

export const sectionLabel = 'px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'

/** The address bar's dropdown; `highlighted` indexes the rows across sections */
export function Suggestions({ sections, highlighted, onOpen, onHighlight }: { sections: SuggestionSection[]; highlighted: number; onOpen: (url: string) => void; onHighlight: (index: number) => void }): React.JSX.Element {
  let index = 0
  return (
    <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
      {sections.map((section) => (
        <div key={section.title}>
          <div className={sectionLabel}>{section.title}</div>
          {section.items.map((item) => {
            const at = index++
            return <SuggestionRow key={`${section.title}:${item.url}`} item={item} active={at === highlighted} onOpen={onOpen} onHover={() => onHighlight(at)} />
          })}
        </div>
      ))}
    </div>
  )
}
