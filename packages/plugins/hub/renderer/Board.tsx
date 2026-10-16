import { type SessionSummary, useHost, PANE_HEADER } from '@treeix/sdk'
import { isAgent } from '@treeix/app/agents'
import { useSessions } from '@treeix/app/plugins'
import { Icon } from '@treeix/app/Icon'
import { timeAgo } from '@treeix/app/time'
import { errorMessage, usePersisted } from '@treeix/app/ui'
import type { TicketRun } from '../shared/types'
import type { Run } from '../shared/workflow'
import { shownRun, StatusIcon } from './RunView'
import { runTitle } from './Sections'
import { hubApi, hubRuns, hubSelection, hubTicketRuns } from './store'

const DAY_MS = 24 * 60 * 60 * 1000
const COLUMNS = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' }
] as const
type Column = (typeof COLUMNS)[number]['id']

type Card = {
  id: string
  column: Column
  title: React.ReactNode
  summary: string
  at: number
  status: ReturnType<typeof shownRun>
  /** Absent while the card's agent works somewhere the board can't open */
  open?: () => void
  /** The MR or PR the agent opened */
  link?: string
  /** An approval step the card can answer in place */
  decide?: (approved: boolean) => void
}

const firstLine = (text: string | null | undefined): string => text?.trim().split('\n')[0] ?? ''

/** What the run is on, or how it ended, in a line */
function runSummary(run: Run): string {
  const nodes = Object.values(run.nodes)
  const waiting = nodes.find((node) => node.waiting)
  if (waiting) return waiting.waiting === 'approval' ? firstLine(waiting.prompt) || 'Waiting for approval' : 'Asks for permission'
  const failed = nodes.find((node) => node.error)
  if (run.status === 'failed' && failed) return firstLine(failed.error)
  if (run.status === 'interrupted') return 'The app quit while it ran'
  return firstLine(run.output) || firstLine(run.input)
}

function runColumn(run: Run): Column | null {
  const shown = shownRun(run)
  if (shown === 'waiting' || shown === 'failed' || shown === 'interrupted') return 'needs'
  if (shown === 'running') return 'running'
  // Old runs stay in the history, not on the board
  return shown === 'done' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS ? 'done' : null
}

function sessionColumn(session: SessionSummary): Column | null {
  if (session.status === 'input') return 'needs'
  if (session.status === 'running' || session.status === 'watching') return 'running'
  return session.status === 'done' || session.status === 'idle' ? 'done' : null
}

const SESSION_STATUS = { needs: 'waiting', running: 'running', done: 'done' } as const

const TICKET: Record<TicketRun['status'], { column: Column; shown: ReturnType<typeof shownRun>; label: string }> = {
  running: { column: 'running', shown: 'running', label: 'Working on it' },
  question: { column: 'needs', shown: 'waiting', label: 'Asked on the ticket' },
  hold: { column: 'needs', shown: 'waiting', label: 'On hold' },
  failed: { column: 'needs', shown: 'failed', label: 'Failed' },
  mr: { column: 'done', shown: 'done', label: 'Opened a merge request' },
  stopped: { column: 'done', shown: 'cancelled', label: 'Stopped' }
}

/** Runs cut short by a quit that a Restore can pick up: recent ones only, so an old one doesn't keep the button around */
export const restorableRuns = (runs: Run[]): Run[] => runs.filter((run) => run.status === 'interrupted' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS)

/** Starts the sessions a relaunch left dormant and resumes interrupted runs, each agent in its own conversation */
function RestoreButton(): React.JSX.Element | null {
  const host = useHost()
  const sessions = useSessions()
  const runs = hubRuns.use()
  const dormant = sessions.filter((session) => session.status === 'dormant').length
  const interrupted = restorableRuns(runs)
  const count = dormant + interrupted.length
  if (!count) return null
  const restore = (): void =>
    void Promise.all([host.service('sessions')?.restoreDormant(), ...interrupted.map((run) => hubApi.resume(run.id))]).catch((reason: unknown) => host.flash(errorMessage(reason)))
  return (
    <button
      onClick={restore}
      title="Start the sessions and runs the last quit stopped, and let their agents carry on"
      className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-white"
    >
      <Icon name="history" className="size-3.5" />
      Restore ({count})
    </button>
  )
}

function BoardCard({ card }: { card: Card }): React.JSX.Element {
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center gap-2 text-xs font-medium">{card.title}</span>
      {card.summary && <span className="line-clamp-2 text-[11px] text-muted-foreground">{card.summary}</span>}
      <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        <StatusIcon status={card.status} className="size-3" />
        <span className="flex-1">{timeAgo(new Date(card.at).toISOString())}</span>
      </span>
    </>
  )
  return (
    <div className="relative rounded-lg bg-background ring-1 ring-border hover:ring-foreground/30">
      {card.open ? (
        <button onClick={card.open} className="flex w-full min-w-0 flex-col gap-1 p-2.5 text-left">
          {body}
        </button>
      ) : (
        <div className="flex w-full min-w-0 flex-col gap-1 p-2.5">{body}</div>
      )}
      {card.link && (
        <button onClick={() => window.open(card.link, '_blank')} className="absolute right-2 bottom-2 text-[11px] text-primary hover:underline">
          Open MR
        </button>
      )}
      {card.decide && (
        <div className="flex justify-end gap-1.5 border-t border-border p-2">
          <button onClick={() => card.decide?.(false)} className="h-6 rounded-md px-2 text-xs ring-1 ring-border hover:bg-accent">
            Reject
          </button>
          <button onClick={() => card.decide?.(true)} className="h-6 rounded-md bg-primary px-2 text-xs font-medium text-white">
            Approve
          </button>
        </div>
      )}
    </div>
  )
}

/** Every agent at work in one place: hub runs, agent sessions and ticket runs, by whether they need the user, run, or are done */
export function Board(): React.JSX.Element {
  const host = useHost()
  const sessionsService = host.service('sessions')
  const sessions = useSessions()
  const runs = hubRuns.use()
  const ticketRuns = hubTicketRuns.use()
  const [layout, setLayout] = usePersisted<'board' | 'list'>('hub.board.layout', 'board')

  const runCards = runs.flatMap((run): Card[] => {
    const column = runColumn(run)
    if (!column) return []
    const approval = Object.entries(run.nodes).find(([, node]) => node.waiting === 'approval')
    return [
      {
        id: `run:${run.id}`,
        column,
        title: runTitle(run.title),
        summary: runSummary(run),
        at: run.endedAt ?? run.startedAt,
        status: shownRun(run),
        open: () => hubSelection.set(`run:${run.id}`),
        decide: approval ? (approved) => hubApi.decide(run.id, approval[0], approved) : undefined
      }
    ]
  })
  const sessionCards = sessions.flatMap((session): Card[] => {
    const column = isAgent(session.kind) ? sessionColumn(session) : null
    if (!column) return []
    return [
      {
        id: `session:${session.id}`,
        column,
        title: (
          <>
            <Icon name={session.view === 'chat' ? 'comment' : 'terminal'} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
          </>
        ),
        summary: session.worktreePath.split('/').slice(-2).join('/'),
        at: session.startedAt,
        status: SESSION_STATUS[column],
        open: () => sessionsService?.reveal(session.id)
      }
    ]
  })
  const ticketCards = ticketRuns.flatMap((run): Card[] => {
    const { column, shown, label } = TICKET[run.status]
    if (column === 'done' && Date.now() - (run.endedAt ?? run.startedAt) >= DAY_MS) return []
    return [
      {
        id: `ticket:${run.item}`,
        column,
        title: runTitle(`${run.item} ${run.title}`),
        summary: firstLine(run.error) || `${run.project}: ${label}`,
        at: run.endedAt ?? run.startedAt,
        status: shown,
        // The runner owns a running session; resuming it as well would fork the conversation
        open:
          run.status === 'running' || !sessionsService
            ? undefined
            : () =>
                void sessionsService.runCommand(run.cwd, `claude --resume ${run.sessionId}`).then(sessionsService.reveal, (reason: unknown) => host.flash(errorMessage(reason))),
        link: run.url ?? undefined
      }
    ]
  })
  const cards = [...runCards, ...sessionCards, ...ticketCards].sort((a, b) => b.at - a.at)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`${PANE_HEADER} gap-2 pr-1.5 pl-3`}>
        <span className="flex-1 text-sm font-medium">Agents</span>
        <RestoreButton />
        <div className="flex rounded-md p-0.5 ring-1 ring-border">
          {(['board', 'list'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setLayout(option)}
              className={`h-6 rounded px-2 text-xs capitalize ${layout === option ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <div className={`min-h-0 flex-1 overflow-auto p-3 ${layout === 'board' ? 'grid grid-cols-3 items-start gap-3' : 'flex flex-col gap-4'}`}>
        {COLUMNS.map((column) => {
          const shown = cards.filter((card) => card.column === column.id)
          return (
            <section key={column.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border">
              <h3 className="flex items-center justify-between px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {column.label}
                <span className="tabular-nums">{shown.length}</span>
              </h3>
              {shown.map((card) => (
                <BoardCard key={card.id} card={card} />
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
