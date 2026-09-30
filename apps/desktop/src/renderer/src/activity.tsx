import type { SessionStatus } from '@treeix/sdk'

/** What a group of agent sessions shows: `ready` is an agent open at its prompt, `none` no live agent */
export type Activity = 'input' | 'done' | 'running' | 'ready' | 'none'

/** A question first, then a finished turn not seen yet, then work in progress, then an agent waiting for a prompt */
export const agentActivity = (statuses: SessionStatus[]): Activity =>
  (['input', 'done', 'running'] as const).find((status) => statuses.includes(status)) ?? (statuses.includes('idle') ? 'ready' : 'none')

/** States worth a mark where space is short, like the workspace rail and the sidebar */
export const NEWS: Activity[] = ['input', 'done', 'running']

export const ACTIVITY_LABEL: Record<Activity, string> = {
  input: 'An agent needs you',
  done: 'An agent finished, not seen yet',
  running: 'An agent is working',
  ready: 'An agent is open, waiting for a prompt',
  none: 'No agent open'
}

/** Amber: needs you; blue: finished, not seen yet; spinning green: working; grey ring: agent open; grey dot: none */
export function ActivityMark({ activity, className = 'size-2.5' }: { activity: Activity; className?: string }): React.JSX.Element {
  const shape = {
    input: 'size-full bg-amber-400 ring-2 ring-amber-400/25',
    done: 'size-full bg-blue-400',
    running: 'size-full animate-spin border-[1.5px] border-emerald-400 border-t-transparent',
    ready: 'size-full border-[1.5px] border-foreground/35',
    none: 'size-1/2 bg-foreground/20'
  }[activity]
  return (
    <span title={ACTIVITY_LABEL[activity]} className={`grid shrink-0 place-items-center ${className}`}>
      <span className={`rounded-full ${shape}`} />
    </span>
  )
}
