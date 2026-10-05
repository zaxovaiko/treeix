import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createBridge, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { openMenu } from '@treeix/app/contextMenu'
import { CopyButton, IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import type { ConsoleEntry, NetworkEntry, Vital } from '../shared/types'
import { consoleComment, curlCommand, entryCommentId, networkComment, seconds, vitalComment } from './comments'
import { useEntries } from './entries'
import type { BrowserTab } from './tabs'

const bridge = createBridge('browser')
type Pane = 'console' | 'network' | 'performance'
export type StripSide = 'bottom' | 'left' | 'right'
const SIDES: StripSide[] = ['bottom', 'left', 'right']

let toggleShown: (() => void) | null = null
/** ⌘J: opens or hides the strip on screen; false when none is */
export const toggleStrip = (): boolean => (toggleShown?.(), toggleShown !== null)

const isProblem = (entry: NetworkEntry): boolean => entry.failed !== null || (entry.status ?? 0) >= 400
const tone = (bad: boolean, warn = false): string => (bad ? 'text-red-400' : warn ? 'text-amber-400' : 'text-muted-foreground')

/** Console, network and performance of the page, docked on `side` of it; `slot` is where its pane switches render, in the address bar */
export function Strip({ tab, slot, side, onSide }: { tab: BrowserTab; slot: HTMLElement | null; side: StripSide; onSide: (side: StripSide) => void }): React.JSX.Element {
  const host = useHost()
  const [open, setOpen] = usePersisted<boolean>('browser.strip', false)
  const [pane, setPane] = usePersisted<Pane>('browser.stripPane', 'console')
  const [all, setAll] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [height, setHeight] = usePersisted<number>('browser.stripHeight', 144)
  const [width, setWidth] = usePersisted<number>('browser.stripWidth', 420)
  useEffect(() => {
    const toggle = (): void => setOpen(!open)
    toggleShown = toggle
    return () => {
      if (toggleShown === toggle) toggleShown = null
    }
  }, [open])
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
  const detail = pane === 'network' ? network.find((entry) => entry.id === detailId) : undefined
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
            cells: [
              entry.name,
              [entry.element, entry.detail].filter(Boolean).join(' · '),
              entry.name === 'CLS' ? String(Math.round(entry.value * 100) / 100) : `${Math.round(entry.value)} ms`,
              entry.start ? `at ${seconds(entry.start)}` : ''
            ],
            bad: (entry.name === 'LCP' && entry.value > 4000) || (entry.name === 'INP' && entry.value > 500) || (entry.name === 'CLS' && entry.value > 0.25),
            warn:
              entry.name === 'Long task' ||
              (entry.name === 'LCP' && entry.value > 2500) ||
              (entry.name === 'INP' && entry.value > 200) ||
              (entry.name === 'CLS' && entry.value > 0.1)
          }))
  const paneButton = (id: Pane, label: string, badge?: number): React.JSX.Element => {
    const shown = pane === id && open
    return (
      <button
        title={shown ? `Hide ${label}` : label}
        aria-pressed={shown}
        onClick={() => (shown ? setOpen(false) : (setPane(id), setOpen(true)))}
        className={`flex h-6 shrink-0 items-center gap-1.5 rounded px-2 text-xs ${shown ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
      >
        {label}
        {!!badge && <span className="rounded bg-red-400/15 px-1 text-[10.5px] text-red-400 tabular-nums">{badge}</span>}
      </button>
    )
  }
  // The pane switches sit in the address bar's right end; only the open pane takes room under the page
  const bar = (
    <>
      {paneButton('console', 'Console', errors)}
      {paneButton('network', 'Network')}
      {paneButton('performance', 'Performance')}
      {host.renderSendButton(worktree, 'pill')}
      {pane !== 'performance' && open && (
        <IconButton label={all ? 'Only problems' : 'Show all'} active={all} onClick={() => setAll(!all)}>
          <Icon name="list" className="size-3.5" />
        </IconButton>
      )}
      {open && (
        <button
          title={`Docked ${side}; click to move`}
          aria-label="Move panel"
          onClick={(event) =>
            openMenu(
              event,
              SIDES.filter((target) => target !== side).map((target) => ({ label: `Dock ${target}`, run: () => onSide(target) }))
            )
          }
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="panel" className={`size-3.5 ${side === 'bottom' ? 'rotate-90 -scale-x-100' : side === 'right' ? '-scale-x-100' : ''}`} />
        </button>
      )}
    </>
  )
  const across = side !== 'bottom'
  return (
    <>
      {slot && createPortal(bar, slot)}
      {open && (
        <div style={across ? { width } : { height }} className={`relative shrink-0 border-border ${{ bottom: 'border-t', left: 'border-r', right: 'border-l' }[side]}`}>
          {across ? <ResizeHandle edge={side === 'left' ? 'right' : 'left'} onResize={setWidth} /> : <ResizeHandle edge="top" onResize={setHeight} />}
          <div className="h-full overflow-y-auto">
            {detail && guestId !== null && <RequestDetail entry={detail} guestId={guestId} onClose={() => setDetailId(null)} />}
            {!detail && rows.length === 0 && <div className="px-5 py-4 text-xs text-muted-foreground">Nothing yet. Tick a row to hand it to the agent</div>}
            {!detail &&
              rows
                .slice()
                .reverse()
                .map(({ entry, cells, bad, warn }) => (
                  <label
                    key={entry.id}
                    title={entry.kind === 'network' ? 'Click for headers, payload, response and curl' : undefined}
                    onClick={(event) => {
                      // A network row opens its details; only its checkbox hands it to the agent
                      if (entry.kind !== 'network' || event.target instanceof HTMLInputElement) return
                      event.preventDefault()
                      setDetailId(entry.id)
                    }}
                    className="grid cursor-pointer grid-cols-[16px_72px_minmax(0,1fr)_72px_64px] items-center gap-2 border-t border-border px-5 py-1.5 font-mono text-[11px] hover:bg-accent/50"
                  >
                    <input type="checkbox" checked={ticked(entry)} onChange={() => void toggle(entry)} />
                    <span className={`truncate ${tone(bad, warn)}`}>{cells[0]}</span>
                    <span className="truncate" title={cells[1]}>
                      {cells[1]}
                    </span>
                    <span className={`text-right ${tone(bad, warn)}`}>{cells[2]}</span>
                    <span className="text-right text-muted-foreground">{cells[3]}</span>
                  </label>
                ))}
          </div>
        </div>
      )}
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-t border-border px-5 py-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

const pretty = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function HeaderList({ values }: { values: Record<string, string> }): React.JSX.Element {
  const entries = Object.entries(values)
  if (!entries.length) return <div className="text-muted-foreground">None</div>
  return (
    <div className="grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-3 select-text">
      {entries.map(([name, value]) => (
        <div key={name} className="contents">
          <span className="text-muted-foreground">{name}</span>
          <span className="break-all">{value}</span>
        </div>
      ))}
    </div>
  )
}

/** One request in full: headers, what went up, what came back, and the curl to replay it */
function RequestDetail({ entry, guestId, onClose }: { entry: NetworkEntry; guestId: number; onClose: () => void }): React.JSX.Element {
  const [body, setBody] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    setBody(undefined)
    void bridge
      .invoke<string | null>('responseBody', guestId, entry.id)
      .catch(() => null)
      .then(setBody)
  }, [guestId, entry.id, entry.status])
  const code = 'max-h-80 overflow-auto rounded bg-muted/50 p-2 whitespace-pre-wrap break-all select-text'
  return (
    <div className="font-mono text-[11px]">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-background px-3 py-1">
        <IconButton label="Back to requests" onClick={onClose}>
          <Icon name="arrowLeft" className="size-3.5" />
        </IconButton>
        <span className={tone(isProblem(entry))}>{entry.method}</span>
        <span className="min-w-0 flex-1 truncate select-text" title={entry.url}>
          {entry.url}
        </span>
        <span className={tone(isProblem(entry), entry.status === null)}>{entry.failed ?? entry.status ?? 'pending'}</span>
        <CopyButton label="Copy as cURL" className="size-3.5" text={() => curlCommand(entry)} />
      </div>
      <Section title="cURL">
        <pre className={code}>{curlCommand(entry)}</pre>
      </Section>
      <Section title="Request headers">
        <HeaderList values={entry.requestHeaders} />
      </Section>
      {entry.postData && (
        <Section title="Request body">
          <pre className={code}>{pretty(entry.postData)}</pre>
        </Section>
      )}
      <Section title="Response headers">
        <HeaderList values={entry.responseHeaders} />
      </Section>
      <Section title="Response body">
        {body === undefined ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : body ? (
          <pre className={code}>{pretty(body)}</pre>
        ) : (
          <div className="text-muted-foreground">Not available</div>
        )}
      </Section>
    </div>
  )
}
