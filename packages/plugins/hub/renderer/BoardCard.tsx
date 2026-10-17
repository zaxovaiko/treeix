import { timeAgo } from '@treeix/app/time'
import { TICKET_BADGES, type TicketBadge, type TicketCard } from '../shared/tickets'
import { hubSelection } from './store'

const BADGE_CLASS: Record<TicketBadge, string> = {
  needsYou: 'bg-amber-400/15 text-amber-500',
  error: 'bg-red-400/15 text-red-500',
  ciFailing: 'bg-red-400/15 text-red-500',
  working: 'bg-sky-400/15 text-sky-500',
  review: 'bg-muted text-muted-foreground',
  merged: 'bg-emerald-400/15 text-emerald-500'
}

export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format

/** Tokens over the whole ticket, and what they cost when the agents priced them */
export const spent = (tokens: number, cost: number | null): string => `${compact(tokens)} tokens${cost == null ? '' : ` · $${cost.toFixed(2)}`}`

export function TicketBadgeChip({ badge }: { badge: TicketBadge }): React.JSX.Element {
  return <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${BADGE_CLASS[badge]}`}>{TICKET_BADGES.find((entry) => entry.id === badge)?.label}</span>
}

/** The ticket and the pull request it opened */
export const ticketLinks = (card: TicketCard): { label: string; url: string }[] => [
  ...(card.url ? [{ label: 'Ticket', url: card.url }] : []),
  ...(card.pullRequest ? [{ label: card.pullRequest.includes('merge_requests') ? 'MR' : 'PR', url: card.pullRequest }] : [])
]

export function BoardCard({ card, menu }: { card: TicketCard; menu: (event: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <div onContextMenu={menu} className="rounded-lg bg-background ring-1 ring-border hover:ring-foreground/30">
      <button onClick={() => hubSelection.set(`ticket:${card.key}`)} className="flex w-full min-w-0 flex-col gap-1 p-2.5 pb-1 text-left">
        <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{card.source === 'jira' ? card.key : card.project}</span>
          <TicketBadgeChip badge={card.badge} />
        </span>
        <span className="line-clamp-2 text-xs font-medium">{card.title}</span>
        {card.summary && <span className="line-clamp-2 text-[11px] text-muted-foreground">{card.summary}</span>}
      </button>
      <div className="flex items-center gap-2 px-2.5 pb-2 text-[11px] text-muted-foreground tabular-nums">
        <span className="min-w-0 flex-1 truncate">{spent(card.tokens, card.cost)}</span>
        {ticketLinks(card).map((link) => (
          <button key={link.url} onClick={() => window.open(link.url, '_blank')} className="text-primary hover:underline">
            {link.label}
          </button>
        ))}
        <span>{timeAgo(new Date(card.at).toISOString())}</span>
      </div>
    </div>
  )
}
