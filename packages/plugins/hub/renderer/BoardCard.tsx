import { timeAgo } from '@treeix/app/time'
import type { Run } from '../shared/workflow'
import { type shownRun, StatusIcon } from './RunView'

export type Card = {
  id: string
  title: React.ReactNode
  summary: string
  at: number
  /** Absent on a pull request no agent has worked on yet */
  status?: ReturnType<typeof shownRun>
  /** Absent while the card's agent works somewhere the board can't open */
  open?: () => void
  /** The ticket the run is for, the PR or MR it opened */
  links?: { label: string; url: string }[]
  /** An approval step the card can answer in place */
  decide?: (approved: boolean) => void
  /** The board stages it can go to */
  moveTo?: (event: React.MouseEvent) => void
}

const firstLine = (text: string | null | undefined): string => text?.trim().split('\n')[0] ?? ''

/** What the run is on, or how it ended, in a line */
export function runSummary(run: Run): string {
  const nodes = Object.values(run.nodes)
  const waiting = nodes.find((node) => node.waiting)
  if (waiting) return waiting.waiting === 'approval' ? firstLine(waiting.prompt) || 'Waiting for approval' : 'Asks for permission'
  const failed = nodes.find((node) => node.error)
  if (run.status === 'failed' && failed) return firstLine(failed.error)
  if (run.status === 'interrupted') return 'The app quit while it ran'
  return firstLine(run.output) || firstLine(run.input)
}

export function BoardCard({ card }: { card: Card }): React.JSX.Element {
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center gap-2 text-xs font-medium">{card.title}</span>
      {card.summary && <span className="line-clamp-2 text-[11px] text-muted-foreground">{card.summary}</span>}
      <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {card.status && <StatusIcon status={card.status} className="size-3" />}
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
      {card.links?.length || card.moveTo ? (
        <div className="absolute right-2 bottom-2 flex gap-2">
          {card.moveTo && (
            <button onClick={card.moveTo} className="text-[11px] text-primary hover:underline">
              Move to…
            </button>
          )}
          {card.links?.map((link) => (
            <button key={link.url} onClick={() => window.open(link.url, '_blank')} className="text-[11px] text-primary hover:underline">
              {link.label}
            </button>
          ))}
        </div>
      ) : null}
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
