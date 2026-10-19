import { useMemo, useState } from 'react'
import { useHost, PANE_HEADER } from '@treeix/sdk'
import { useSessions } from '@treeix/app/plugins'
import { openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { EmptyState, errorMessage, usePersisted } from '@treeix/app/ui'
import type { Run } from '../shared/workflow'
import { DAY_MS } from '../shared/board'
import { filterCards, TICKET_BADGES, TICKET_COLUMNS, type TicketCard, ticketCards, type TicketFilter } from '../shared/tickets'
import { BoardCard } from './BoardCard'
import { TicketDialog, type TicketMode } from './TicketDialog'
import { hubApi, hubRuns, hubTicketStates } from './store'

/** Runs cut short by a quit that a Restore can pick up: recent ones only, so an old one doesn't keep the button around */
export const restorableRuns = (runs: Run[]): Run[] =>
  runs.filter((run) => run.kind !== 'eval' && run.status === 'interrupted' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS)

/** Starts the sessions a relaunch left dormant and resumes interrupted runs, each agent in its own conversation */
function RestoreButton(): React.JSX.Element | null {
  const host = useHost()
  const sessions = useSessions()
  const runs = hubRuns.useValue()
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
      <span className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground">{count}</span>
    </button>
  )
}

/** A filter as a small button that opens its options */
function Pick<T extends string>({ value, options, onPick }: { value: T; options: { id: T; label: string }[]; onPick: (id: T) => void }): React.JSX.Element {
  return (
    <button
      onClick={(event) =>
        openMenu(
          event,
          options.map((option) => ({ label: option.label, checked: option.id === value, run: () => onPick(option.id) }))
        )
      }
      className="flex h-6 items-center gap-1 rounded-md px-2 text-xs ring-1 ring-border hover:bg-accent"
    >
      {options.find((option) => option.id === value)?.label ?? options[0].label}
      <Icon name="chevron" className="size-3 rotate-90 text-muted-foreground" />
    </button>
  )
}

/** Every ticket an agent works on, by where it is: In progress, QA, Pull request, Done */
export function Board(): React.JSX.Element {
  const runs = hubRuns.useValue()
  const states = hubTicketStates.useValue()
  const [project, setProject] = usePersisted<string>('hub.board.project', 'all')
  const [badge, setBadge] = usePersisted<TicketFilter['badge']>('hub.board.badge', 'all')
  const [sort, setSort] = usePersisted<TicketFilter['sort']>('hub.board.sort', 'date')
  // ponytail: one cutoff archives every Done card at once; per-card archive if someone needs to keep a few
  const [archivedAt, setArchivedAt] = usePersisted<number>('hub.board.archivedAt', 0)
  const [ticket, setTicket] = useState<{ source: TicketCard['source']; ticketKey: string; mode: TicketMode } | null>(null)

  const all = useMemo(() => ticketCards(runs, states), [runs, states])
  const projects = [...new Set(all.map((card) => card.project))].sort()
  // A project whose tickets are all gone shows everything again
  const shownProject = projects.includes(project) ? project : 'all'
  const cards = filterCards(all, { project: shownProject, badge, sort }).filter((card) => card.column !== 'done' || card.at > archivedAt)
  const menu = (card: TicketCard) => (event: React.MouseEvent) =>
    openMenu(event, [
      { label: 'Preview ticket', run: () => setTicket({ source: card.source, ticketKey: card.key, mode: 'preview' }) },
      { label: 'Edit ticket…', run: () => setTicket({ source: card.source, ticketKey: card.key, mode: 'edit' }) },
      { label: 'Comment for the agent…', run: () => setTicket({ source: card.source, ticketKey: card.key, mode: 'comment' }) }
    ])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`${PANE_HEADER} gap-2 pr-1.5 pl-3`}>
        <span className="flex-1 text-sm font-medium">Agents</span>
        <Pick value={shownProject} options={[{ id: 'all', label: 'All projects' }, ...projects.map((id) => ({ id, label: id }))]} onPick={setProject} />
        <Pick value={badge} options={[{ id: 'all', label: 'Any status' }, ...TICKET_BADGES]} onPick={setBadge} />
        <Pick
          value={sort}
          options={[
            { id: 'date', label: 'Newest' },
            { id: 'tokens', label: 'Most tokens' }
          ]}
          onPick={setSort}
        />
        <RestoreButton />
      </header>
      {all.length === 0 ? (
        <EmptyState icon="ticket" title="No tickets yet. Make a Ship Jira tickets or Ship Notion tasks workflow with + under Workflows, then tag a ticket agent-ready." fill />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-4 items-start gap-3 overflow-auto p-3">
          {TICKET_COLUMNS.map((column) => {
            const shown = cards.filter((card) => card.column === column.id)
            return (
              <section key={column.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border">
                <h3 className="flex items-center gap-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <span className="flex-1">{column.label}</span>
                  {column.id === 'done' && shown.length > 0 && (
                    <button
                      onClick={() => setArchivedAt(Date.now())}
                      title="Clears the done tickets from the board; their runs stay in History"
                      className="normal-case hover:text-foreground"
                    >
                      Archive
                    </button>
                  )}
                  <span className="tabular-nums">{shown.length}</span>
                </h3>
                {shown.map((card) => (
                  <BoardCard key={card.key} card={card} menu={menu(card)} />
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
