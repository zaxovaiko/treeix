import type { WorkItem } from '../shared/types'
import { priorityRank } from './buckets'

const CATEGORY_STYLE: Record<WorkItem['statusCategory'], string> = {
  new: 'bg-foreground/8 text-muted-foreground',
  indeterminate: 'bg-sky-400/12 text-sky-400',
  done: 'bg-emerald-400/12 text-emerald-400'
}

type TypeLook = { className: string; path: React.ReactNode }
/** Jira's own shapes, so a bug reads as a bug before the text does */
const TYPE_LOOKS: { match: RegExp; look: TypeLook }[] = [
  { match: /bug|defect|incident/i, look: { className: 'bg-red-500', path: <circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" /> } },
  { match: /epic/i, look: { className: 'bg-violet-500', path: <path d="M9 2.5 4.5 9H8l-1 4.5L11.5 7H8z" fill="currentColor" stroke="none" /> } },
  { match: /story/i, look: { className: 'bg-green-600', path: <path d="M5 3h6v10l-3-2.2L5 13z" fill="currentColor" stroke="none" /> } },
  {
    match: /sub.?task/i,
    look: {
      className: 'bg-sky-500',
      path: (
        <>
          <rect x="3" y="3" width="6" height="6" rx="1" />
          <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1" fill="currentColor" stroke="none" />
        </>
      )
    }
  },
  { match: /./, look: { className: 'bg-sky-500', path: <path d="m4.5 8.2 2.3 2.3 4.7-5" /> } }
]
const lookOf = (type: string): TypeLook => (TYPE_LOOKS.find(({ match }) => match.test(type)) ?? TYPE_LOOKS[TYPE_LOOKS.length - 1]).look

export const isBug = (type: string): boolean => /bug|defect|incident/i.test(type)

export function TypeMark({ type }: { type: string }): React.JSX.Element {
  const { className, path } = lookOf(type)
  return (
    <span title={type} className={`grid size-4 shrink-0 place-items-center rounded-[4px] text-white ${className}`}>
      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    </span>
  )
}

/** Long custom status names truncate inside the pill; the full name is in the tooltip */
export const StatusPill = ({ item }: { item: Pick<WorkItem, 'status' | 'statusCategory'> }): React.JSX.Element => (
  <span title={item.status} className={`h-[18px] max-w-36 min-w-0 truncate rounded px-1.5 text-[10.5px] leading-[18px] font-medium whitespace-nowrap ${CATEGORY_STYLE[item.statusCategory]}`}>
    {item.status}
  </span>
)

export const BugPill = ({ type }: { type: string }): React.JSX.Element => (
  <span className="h-[18px] shrink-0 rounded bg-red-500/12 px-1.5 text-[10.5px] leading-[18px] font-medium text-red-400">{type}</span>
)

const PRIORITY_GLYPHS = ['⇈', '↑', '', '↓', '⇊']
/** Arrows for anything but the default priority, so rows stay quiet unless it matters */
export function PriorityMark({ priority }: { priority: string | null }): React.JSX.Element | null {
  const rank = priorityRank(priority)
  if (!priority || rank === 2) return null
  return (
    <span title={`${priority} priority`} className={`shrink-0 font-mono text-[11px] ${rank < 2 ? 'text-red-400' : 'text-muted-foreground'}`}>
      {PRIORITY_GLYPHS[rank]}
    </span>
  )
}

/** The epic an item belongs to, as a small purple label */
export const EpicChip = ({ summary, onClick }: { summary: string; onClick?: () => void }): React.JSX.Element => (
  <span
    title={`Epic: ${summary}`}
    onClick={
      onClick &&
      ((event) => {
        event.stopPropagation()
        onClick()
      })
    }
    className={`min-w-0 shrink truncate rounded bg-violet-500/12 px-1.5 text-[10.5px] leading-[18px] font-medium text-violet-400 ${onClick ? 'cursor-pointer hover:bg-violet-500/20' : ''}`}
  >
    {summary}
  </span>
)

/** Done children of an epic out of all of them */
export function EpicProgress({ done, total }: { done: number; total: number }): React.JSX.Element {
  return (
    <span title={`${done} of ${total} done`} className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-normal tracking-normal text-muted-foreground normal-case tabular-nums">
      <span className="h-1 w-10 overflow-hidden rounded-full bg-foreground/10">
        <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </span>
      {done}/{total}
    </span>
  )
}
