import { PANE_HEADER } from '@treeix/sdk'
import { IconButton } from '@treeix/app/ui'
import { Icon } from '@treeix/app/Icon'
import { runSummary } from '../shared/board'
import { runTokens, TICKET_COLUMNS, type TicketCard } from '../shared/tickets'
import { compact, spent, TicketBadgeChip, ticketLinks } from './BoardCard'
import { shownRun, StatusIcon } from './RunView'
import { runTitle } from './Sections'
import { hubBack, hubSelection } from './store'

type Entry = { at: number; text: string } | { at: number; run: TicketCard['runs'][number] }

/** A ticket's whole trail, oldest first: every run on it and everything the pull request watcher did, errors included */
export function TicketView({ card }: { card: TicketCard }): React.JSX.Element {
  const entries: Entry[] = [...(card.state?.log ?? []), ...card.runs.map((run) => ({ at: run.startedAt, run }))].sort((a, b) => a.at - b.at)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`${PANE_HEADER} gap-2.5 pr-3 pl-1.5`}>
        <IconButton label="Back" onClick={hubBack}>
          <Icon name="arrowLeft" className="size-3.5" />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-[13px] leading-none font-medium">{card.title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] leading-none text-muted-foreground tabular-nums">
            {[card.source === 'jira' ? card.key : card.project, TICKET_COLUMNS.find((column) => column.id === card.column)?.label, spent(card.tokens, card.cost)].join(' · ')}
          </div>
        </div>
        <TicketBadgeChip badge={card.badge} />
        {ticketLinks(card).map((link) => (
          <button key={link.url} onClick={() => window.open(link.url, '_blank')} className="text-xs text-primary hover:underline">
            {link.label}
          </button>
        ))}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {card.summary && <p className="mb-3 text-[13px]">{card.summary}</p>}
        <ol className="flex flex-col">
          {entries.map((entry) =>
            'run' in entry ? (
              <li key={entry.run.id}>
                <button
                  onClick={() => hubSelection.set(`run:${entry.run.id}`)}
                  className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-xs hover:bg-accent/60"
                >
                  <StatusIcon status={shownRun(entry.run)} className="size-3" />
                  <span className="flex max-w-[45%] min-w-0 shrink-0 items-center gap-2 font-medium">{runTitle(entry.run.title)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{runSummary(entry.run)}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{compact(runTokens(entry.run))}</span>
                  <Time at={entry.at} />
                </button>
              </li>
            ) : (
              <li key={`${entry.at}:${entry.text}`} className="flex h-7 items-center gap-2.5 px-2 text-xs text-muted-foreground">
                <span className={`size-1.5 shrink-0 rounded-full ${entry.text.startsWith('Error') ? 'bg-red-400' : 'bg-muted-foreground/50'}`} />
                <span className="min-w-0 flex-1 truncate">{entry.text}</span>
                <Time at={entry.at} />
              </li>
            )
          )}
        </ol>
      </div>
    </div>
  )
}

const Time = ({ at }: { at: number }): React.JSX.Element => (
  <span className="w-28 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
    {new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
  </span>
)
