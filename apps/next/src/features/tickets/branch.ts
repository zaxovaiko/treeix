import type { Ticket, TicketDetail } from '../../ipc/api'

const STOPWORDS = new Set(['a', 'an', 'the', 'its', 'to', 'of', 'per', 'after', 'on', 'in', 'for', 'and'])

export const slug = (s: string) =>
  s
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()

/** `fix/` for bugs, `feat/` otherwise, then the key and four words of the title: `fix/trx-47-ports-popover-loses-focus` */
export const ticketBranch = (t: Pick<Ticket, 'key' | 'kind' | 'title'>) =>
  `${t.kind === 'bug' ? 'fix' : 'feat'}/${[
    t.key.toLowerCase(),
    ...slug(t.title)
      .split('-')
      .filter((w) => w && !STOPWORDS.has(w))
      .slice(0, 4),
  ].join('-')}`

/** Whether a branch was made for the ticket: its key, not a longer one like TRX-412 for TRX-41 */
export const isBranchFor = (branch: string | null, key: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'i').test(branch ?? '')

/** "Your tickets" in Open worktree: the ones without a branch yet that match what is typed */
export function ticketRows(tickets: Ticket[], branches: string[], query: string) {
  const q = query.trim().toLowerCase()
  return tickets.filter((t) => !branches.some((b) => isBranchFor(b, t.key)) && (!q || `${t.key} ${t.title}`.toLowerCase().includes(q)))
}

/** The agent's first prompt for a ticket */
export const ticketPrompt = ({ ticket, description }: TicketDetail) =>
  [`${ticket.key}: ${ticket.title}`, ticket.url, description.trim()].filter(Boolean).join('\n\n')
