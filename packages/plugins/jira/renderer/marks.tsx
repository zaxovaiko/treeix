import type { WorkItem } from '../shared/types'

const CATEGORY_STYLE: Record<WorkItem['statusCategory'], string> = {
  new: 'bg-foreground/8 text-muted-foreground',
  indeterminate: 'bg-primary/12 text-primary',
  done: 'bg-emerald-400/12 text-emerald-400'
}
const TYPE_STYLE: Record<string, string> = { Bug: 'bg-red-500', Story: 'bg-green-600', Epic: 'bg-violet-500' }

export function TypeMark({ type }: { type: string }): React.JSX.Element {
  return (
    <span title={type} className={`grid size-[15px] shrink-0 place-items-center rounded-[3px] text-[9px] font-bold text-white ${TYPE_STYLE[type] ?? 'bg-sky-500'}`}>
      {type.slice(0, 1)}
    </span>
  )
}

export const StatusPill = ({ item }: { item: WorkItem }): React.JSX.Element => (
  <span className={`h-[18px] shrink-0 rounded px-1.5 text-[10.5px] leading-[18px] font-medium whitespace-nowrap ${CATEGORY_STYLE[item.statusCategory]}`}>{item.status}</span>
)

