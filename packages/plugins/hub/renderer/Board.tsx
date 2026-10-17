import { useState } from 'react'
import { useHost, PANE_HEADER } from '@treeix/sdk'
import { useSessions } from '@treeix/app/plugins'
import { openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { errorMessage, usePersisted } from '@treeix/app/ui'
import { type Run, ticketOf } from '../shared/workflow'
import { BOARD_COLUMNS, type BoardColumn, boardColumn, DAY_MS, runLinks, runSummary } from '../shared/board'
import { BoardCard, type Card, ListRow } from './BoardCard'
import { shownRun } from './RunView'
import { runTitle } from './Sections'
import { TicketDialog, type TicketMode } from './TicketDialog'
import { Pipeline } from './Pipeline'
import { hubApi, hubRuns, hubSelection } from './store'

type StatusCard = Card & { column: BoardColumn }

const LAYOUTS = { board: 'Board', list: 'List', prs: 'Pull requests' } as const

/** Runs cut short by a quit that a Restore can pick up: recent ones only, so an old one doesn't keep the button around */
export const restorableRuns = (runs: Run[]): Run[] =>
  runs.filter((run) => run.kind !== 'eval' && run.status === 'interrupted' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS)

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
      title={`Restore ${count}: start the sessions and runs the last quit stopped, and let their agents carry on`}
      aria-label={`Restore ${count}`}
      className="relative flex size-7 items-center justify-center rounded-md text-primary hover:bg-accent"
    >
      <Icon name="history" className="size-4" />
      <span className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-white">{count}</span>
    </button>
  )
}

/** Workflow runs and asks, by whether they need the user, run, or are done; terminal agents stay in their sessions */
export function Board(): React.JSX.Element {
  const runs = hubRuns.use()
  const [layout, setLayout] = usePersisted<keyof typeof LAYOUTS>('hub.board.layout', 'board')
  // ponytail: one cutoff archives every Done card at once; per-card archive if someone needs to keep a few
  const [archivedAt, setArchivedAt] = usePersisted<number>('hub.board.archivedAt', 0)
  const [ticket, setTicket] = useState<{ source: 'jira' | 'notion'; ticketKey: string; mode: TicketMode } | null>(null)

  const cards = runs.flatMap((run): StatusCard[] => {
    const column = boardColumn(run)
    if (!column || (column === 'done' && (run.endedAt ?? run.startedAt) <= archivedAt)) return []
    const approval = Object.entries(run.nodes).find(([, node]) => node.waiting === 'approval')
    const about = ticketOf(run)
    return [
      {
        id: `run:${run.id}`,
        column,
        title: runTitle(run.title),
        summary: runSummary(run),
        at: run.endedAt ?? run.startedAt,
        status: shownRun(run),
        open: () => hubSelection.set(`run:${run.id}`),
        links: runLinks(run),
        decide: approval ? (approved) => hubApi.decide(run.id, approval[0], approved) : undefined,
        menu: about
          ? (event) =>
              openMenu(event, [
                { label: 'Preview ticket', run: () => setTicket({ source: about.source, ticketKey: about.key, mode: 'preview' }) },
                { label: 'Edit ticket…', run: () => setTicket({ source: about.source, ticketKey: about.key, mode: 'edit' }) },
                { label: 'Comment for the agent…', run: () => setTicket({ source: about.source, ticketKey: about.key, mode: 'comment' }) }
              ])
          : undefined
      }
    ]
  })
  cards.sort((a, b) => b.at - a.at)
  const list = layout === 'list'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`${PANE_HEADER} gap-2 pr-1.5 pl-3`}>
        <span className="flex-1 text-sm font-medium">Agents</span>
        <RestoreButton />
        <div className="flex rounded-md p-0.5 ring-1 ring-border">
          {(['board', 'list', 'prs'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setLayout(option)}
              className={`h-6 rounded px-2 text-xs ${layout === option ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              {LAYOUTS[option]}
            </button>
          ))}
        </div>
      </header>
      {layout === 'prs' ? (
        <Pipeline />
      ) : (
        <div className={`min-h-0 flex-1 overflow-auto ${list ? '' : 'grid grid-cols-3 items-start gap-3 p-3'}`}>
          {BOARD_COLUMNS.map((column) => {
            const shown = cards.filter((card) => card.column === column.id)
            const archive = column.id === 'done' && shown.length > 0 && (
              <button onClick={() => setArchivedAt(Date.now())} title="Clears the done runs from the board; they stay in History" className="normal-case hover:text-foreground">
                Archive
              </button>
            )
            const count = <span className="tabular-nums">{shown.length}</span>
            return list ? (
              <section key={column.id} className="flex flex-col">
                <h3 className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-border bg-muted/60 px-3 text-[11px] font-medium text-muted-foreground backdrop-blur">
                  <span className="text-foreground">{column.label}</span>
                  {count}
                  <span className="flex-1" />
                  {archive}
                </h3>
                <div className="flex flex-col divide-y divide-border/50">
                  {shown.map((card) => (
                    <ListRow key={card.id} card={card} />
                  ))}
                </div>
              </section>
            ) : (
              <section key={column.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border">
                <h3 className="flex items-center gap-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <span className="flex-1">{column.label}</span>
                  {archive}
                  {count}
                </h3>
                {shown.map((card) => (
                  <BoardCard key={card.id} card={card} />
                ))}
              </section>
            )
          })}
        </div>
      )}
      {ticket && <TicketDialog {...ticket} onClose={() => setTicket(null)} />}
    </div>
  )
}
