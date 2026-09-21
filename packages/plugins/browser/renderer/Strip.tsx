import { useState } from 'react'
import { createBridge, useHost } from '@treeix/sdk'
import { usePersisted } from '@treeix/app/ui'
import type { ConsoleEntry, NetworkEntry, Vital } from '../shared/types'
import { consoleComment, entryCommentId, networkComment, vitalComment } from './comments'
import { useEntries } from './entries'
import type { BrowserTab } from './tabs'

const bridge = createBridge('browser')
type Pane = 'console' | 'network' | 'performance'

const isProblem = (entry: NetworkEntry): boolean => entry.failed !== null || (entry.status ?? 0) >= 400
const tone = (bad: boolean, warn = false): string => (bad ? 'text-red-400' : warn ? 'text-amber-400' : 'text-muted-foreground')

export function Strip({ tab }: { tab: BrowserTab }): React.JSX.Element {
  const host = useHost()
  const [open, setOpen] = usePersisted<boolean>('browser.strip', true)
  const [pane, setPane] = usePersisted<Pane>('browser.stripPane', 'console')
  const [all, setAll] = useState(false)
  const { console: logs, network, vitals } = useEntries(tab.guestId)
  const worktree = host.selectedWorktree ?? host.defaultCwd
  const { guestId } = tab
  const ticked = (entry: ConsoleEntry | NetworkEntry | Vital): boolean => guestId !== null && host.comments.some((comment) => comment.id === entryCommentId(entry, guestId))
  const toggle = async (entry: ConsoleEntry | NetworkEntry | Vital): Promise<void> => {
    if (guestId === null) return
    const id = entryCommentId(entry, guestId)
    const existing = host.comments.find((comment) => comment.id === id)
    if (existing) return host.deleteComment(existing)
    if (entry.kind === 'console') host.addComment(consoleComment(entry, guestId, tab.url, worktree))
    else if (entry.kind === 'vital') host.addComment(vitalComment(entry, guestId, tab.url, worktree))
    else {
      const body = await bridge.invoke<string | null>('responseBody', guestId, entry.id).catch(() => null)
      host.addComment(networkComment(entry, guestId, body, tab.url, worktree))
    }
  }
  const shownLogs = all ? logs : logs.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  const shownRequests = all ? network : network.filter((entry) => entry.resourceType === 'Fetch' || entry.resourceType === 'XHR' || isProblem(entry))
  const errors = logs.filter((entry) => entry.level === 'error').length
  const rows: { entry: ConsoleEntry | NetworkEntry | Vital; cells: [string, string, string, string]; bad: boolean; warn: boolean }[] =
    pane === 'console'
      ? shownLogs.map((entry) => ({ entry, cells: [entry.level, entry.text, entry.source, ''], bad: entry.level === 'error', warn: entry.level === 'warning' }))
      : pane === 'network'
        ? shownRequests.map((entry) => ({
            entry,
            cells: [entry.method, entry.url, entry.failed ?? (entry.status === null ? 'pending' : String(entry.status)), entry.durationMs === null ? '' : `${entry.durationMs} ms`],
            bad: isProblem(entry),
            warn: entry.status === null
          }))
        : vitals.map((entry) => ({
            entry,
            cells: [entry.name, entry.element, entry.name === 'CLS' ? String(Math.round(entry.value * 100) / 100) : `${Math.round(entry.value)} ms`, ''],
            bad: (entry.name === 'LCP' && entry.value > 4000) || (entry.name === 'INP' && entry.value > 500) || (entry.name === 'CLS' && entry.value > 0.25),
            warn: entry.name === 'Long task' || (entry.name === 'LCP' && entry.value > 2500) || (entry.name === 'INP' && entry.value > 200) || (entry.name === 'CLS' && entry.value > 0.1)
          }))
  const paneButton = (id: Pane, label: string, badge?: number): React.JSX.Element => (
    <button
      onClick={() => (setPane(id), setOpen(true))}
      className={`flex h-8 items-center gap-1.5 border-b-2 px-2 text-xs ${pane === id && open ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label}
      {!!badge && <span className="rounded bg-red-400/15 px-1 text-[10.5px] text-red-400 tabular-nums">{badge}</span>}
    </button>
  )
  return (
    <div className="shrink-0 border-t border-border">
      <div className="flex items-center px-2">
        {paneButton('console', 'Console', errors)}
        {paneButton('network', 'Network')}
        {paneButton('performance', 'Performance')}
        <span className="flex-1" />
        {pane !== 'performance' && open && (
          <button onClick={() => setAll(!all)} className="px-2.5 text-[11px] text-muted-foreground hover:text-foreground">
            {all ? 'Only problems' : 'Show all'}
          </button>
        )}
        <button aria-label={open ? 'Hide' : 'Show'} onClick={() => setOpen(!open)} className="px-2.5 text-[11px] text-muted-foreground hover:text-foreground">
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className="h-36 overflow-y-auto">
          {rows.length === 0 && <div className="px-5 py-4 text-xs text-muted-foreground">Nothing yet. Tick a row to hand it to the agent</div>}
          {rows
            .slice()
            .reverse()
            .map(({ entry, cells, bad, warn }) => (
              <label key={entry.id} className="grid cursor-pointer grid-cols-[16px_56px_minmax(0,1fr)_72px_56px] items-center gap-2 border-t border-border px-5 py-1.5 font-mono text-[11px] hover:bg-accent/50">
                <input type="checkbox" checked={ticked(entry)} onChange={() => void toggle(entry)} />
                <span className={tone(bad, warn)}>{cells[0]}</span>
                <span className="truncate" title={cells[1]}>
                  {cells[1]}
                </span>
                <span className={`text-right ${tone(bad, warn)}`}>{cells[2]}</span>
                <span className="text-right text-muted-foreground">{cells[3]}</span>
              </label>
            ))}
        </div>
      )}
    </div>
  )
}
