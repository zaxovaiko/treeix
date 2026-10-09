import { useEffect } from 'react'
import { useHost } from '@treeix/sdk'
import { agentOr, useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { goToWorkspace, markAllRead, useNotifications } from '@treeix/app/notifications'
import { useSessions } from '@treeix/app/plugins'
import { timeAgo } from '@treeix/app/time'
import { useWorkspaces, workspaceOf } from '@treeix/app/workspaces'
import { type AgentNode, isWaiting, type Run } from '../shared/workflow'
import { Alien, characterOf, type Mood } from './Alien'
import { alienOf } from './AgentEditor'
import type { Character } from '../shared/types'
import { hubAgents, hubRuns, hubSelection, TAB_ID } from './store'

/** One agent at work anywhere: a hub run, or an agent session in any workspace */
type Entry = {
  id: string
  mood: Mood
  title: string
  who: string
  via: string
  character: Character
  at: number
  workspaceId: string | null
  open: () => void
}

const URGENCY: Record<Mood, number> = {
  waiting: 0,
  failed: 1,
  working: 2,
  done: 3,
  idle: 4
}
// A finished run stays listed this long, so a glance after a coffee still shows it
const RECENT_MS = 30 * 60_000
const MAX_ROWS = 8

function runMood(run: Run): Mood | null {
  if (isWaiting(run)) return 'waiting'
  if (run.status === 'running') return 'working'
  if ((run.status === 'done' || run.status === 'failed') && Date.now() - (run.endedAt ?? run.startedAt) < RECENT_MS) return run.status
  return null
}

const SESSION_MOOD: Partial<Record<string, Mood>> = {
  running: 'working',
  input: 'waiting',
  done: 'done'
}

/** Everything the hub's button and card show, most urgent first */
function useEntries(): Entry[] {
  const host = useHost()
  const sessions = useSessions()
  const runs = hubRuns.use()
  const agents = hubAgents.use()
  useAgents()
  const fromSessions = sessions.flatMap((session): Entry[] => {
    const agent = agentOr(session.kind)
    const mood = SESSION_MOOD[session.status]
    if (!agent.agent || !mood) return []
    const open = (): void => {
      goToWorkspace(session.workspaceId)
      host.service('sessions')?.reveal(session.id)
      host.setActiveTab('terminal')
    }
    return [
      {
        id: session.id,
        mood,
        title: session.title,
        who: agent.label,
        via: session.view === 'chat' ? 'Chat' : 'Terminal',
        character: characterOf(session.kind),
        at: session.startedAt,
        workspaceId: session.workspaceId,
        open
      }
    ]
  })
  const fromRuns = runs.flatMap((run): Entry[] => {
    const mood = runMood(run)
    if (!mood) return []
    const first = run.workflow.nodes.find((node): node is AgentNode => node.kind === 'agent')
    const agent = agents.find((candidate) => candidate.id === first?.agent)
    const open = (): void => {
      hubSelection.set(`run:${run.id}`)
      host.setActiveTab(TAB_ID)
    }
    return [
      {
        id: run.id,
        mood,
        title: run.title,
        who: agent?.name ?? run.workflow.name,
        via: 'AI Hub',
        character: agent ? alienOf(agent) : 'shell',
        at: run.endedAt ?? run.startedAt,
        workspaceId: null,
        open
      }
    ]
  })
  return [...fromSessions, ...fromRuns].sort((a, b) => URGENCY[a.mood] - URGENCY[b.mood] || b.at - a.at)
}

const overallMood = (entries: Entry[]): Mood => entries[0]?.mood ?? 'idle'
const overallCharacter = (entries: Entry[]): Character => entries[0]?.character ?? 'claude'

/** The title bar button: the agent in the overall mood, and a dot while something wants a look */
export function HubFace(): React.JSX.Element {
  const entries = useEntries()
  const unread = useNotifications().filter((entry) => !entry.read)
  const dot = entries.some((entry) => entry.mood === 'waiting')
    ? { className: 'bg-amber-400', ping: true, label: 'An agent needs you' }
    : unread.some((entry) => entry.failed)
      ? { className: 'bg-red-500', ping: true, label: 'A run failed' }
      : unread.length
        ? { className: 'bg-emerald-400', ping: false, label: 'Unseen news' }
        : null
  return (
    <>
      <Alien character={overallCharacter(entries)} mood={overallMood(entries)} size={18} />
      AI Hub
      {dot && (
        <span data-hub-attention className="relative flex size-2" aria-label={dot.label}>
          {dot.ping && <span className={`absolute inset-0 animate-ping rounded-full opacity-75 ${dot.className}`} />}
          <span className={`relative size-2 rounded-full ${dot.className}`} />
        </span>
      )}
    </>
  )
}

function say(entries: Entry[]): [string, string] {
  const count = (mood: Mood): number => entries.filter((entry) => entry.mood === mood).length
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  switch (overallMood(entries)) {
    case 'waiting':
      return [`${plural(count('waiting'), 'agent')} need${count('waiting') === 1 ? 's' : ''} you`, 'Answer to let them go on']
    case 'failed':
      return ['Something failed', 'Open it to see why']
    case 'working':
      return [`${plural(count('working'), 'agent')} at work`, 'Nothing needs you yet']
    case 'done':
      return ['All done', `${plural(count('done'), 'result')} to look at`]
    default:
      return ['All quiet', 'Ask an agent to get going']
  }
}

const STATUS: Record<Mood, string> = {
  waiting: 'Answer',
  failed: 'Failed',
  working: 'Working',
  done: 'Done',
  idle: ''
}

/** The card under the button: every agent at work in any workspace, a click away */
export function HubPeek({ close }: { close: () => void }): React.JSX.Element {
  const host = useHost()
  const entries = useEntries()
  const { workspaces } = useWorkspaces()
  // Peeking counts as seeing the news, so the dot goes out
  useEffect(markAllRead, [])
  const [headline, sub] = say(entries)
  const go = (open: () => void): void => {
    open()
    close()
  }
  return (
    <div className="grid w-[560px] grid-cols-[196px_1fr] gap-2.5 p-2.5">
      <div className="flex flex-col items-center justify-center gap-1.5 px-2 pt-3.5 pb-3">
        <Alien character={overallCharacter(entries)} mood={overallMood(entries)} size={148} />
        <div className="text-center text-[12.5px] font-medium">{headline}</div>
        <div className="text-center text-[11px] text-muted-foreground">{sub}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        {entries.length === 0 && <div className="m-auto text-muted-foreground">No agent is at work</div>}
        {entries.slice(0, MAX_ROWS).map((entry) => {
          const workspace = entry.workspaceId ? workspaceOf(workspaces, entry.workspaceId) : undefined
          return (
            <button
              key={entry.id}
              data-peek-entry={entry.mood}
              onClick={() => go(entry.open)}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent"
            >
              <Alien character={entry.character} mood={entry.mood} size={22} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{entry.title}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {entry.who} · {entry.via} · {timeAgo(new Date(entry.at).toISOString())}
                </span>
              </span>
              {workspace && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="size-1.5 rounded-full" style={{ background: workspace.color }} />
                  {workspace.name}
                </span>
              )}
              {entry.mood === 'waiting' ? (
                <span className="h-[22px] shrink-0 rounded-md bg-primary px-2 text-[11px] leading-[22px] font-medium text-primary-foreground">{STATUS.waiting}</span>
              ) : (
                <span className={`shrink-0 text-[11px] ${entry.mood === 'failed' ? 'text-red-400' : 'text-muted-foreground'}`}>{STATUS[entry.mood]}</span>
              )}
            </button>
          )
        })}
        {entries.length > MAX_ROWS && <div className="px-2 text-[11px] text-muted-foreground">{entries.length - MAX_ROWS} more in the AI Hub</div>}
      </div>
      <div className="col-span-2 flex items-center gap-2 border-t border-border px-1 pt-1.5">
        <button onClick={() => go(() => host.setActiveTab(TAB_ID))} className="flex h-[26px] items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground">
          <Icon name="sparkles" />
          Open AI Hub
        </button>
      </div>
    </div>
  )
}
