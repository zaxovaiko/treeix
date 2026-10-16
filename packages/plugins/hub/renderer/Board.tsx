import { type SessionSummary, useHost, PANE_HEADER } from '@treeix/sdk'
import { isAgent } from '@treeix/app/agents'
import { useSessions } from '@treeix/app/plugins'
import { Icon } from '@treeix/app/Icon'
import { errorMessage, usePersisted } from '@treeix/app/ui'
import type { Run } from '../shared/workflow'
import { BoardCard, type Card, runSummary } from './BoardCard'
import { shownRun } from './RunView'
import { runTitle } from './Sections'
import { Pipeline } from './Pipeline'
import { hubApi, hubRuns, hubSelection } from './store'

const DAY_MS = 24 * 60 * 60 * 1000
const COLUMNS = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' }
] as const
type Column = (typeof COLUMNS)[number]['id']

type StatusCard = Card & { column: Column }

/** A GitHub or Bitbucket pull request, or a GitLab merge request */
const PULL_REQUEST = /https?:\/\/\S+?\/(?:pull|pull-requests|-\/merge_requests)\/\d+/

function runColumn(run: Run): Column | null {
  const shown = shownRun(run)
  if (shown === 'waiting' || shown === 'failed' || shown === 'interrupted') return 'needs'
  if (shown === 'running') return 'running'
  // Old runs stay in the history, not on the board
  return shown === 'done' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS ? 'done' : null
}

function sessionColumn(session: SessionSummary): Column | null {
  if (session.status === 'input') return 'needs'
  if (session.status === 'running' || session.status === 'watching') return 'running'
  return session.status === 'done' || session.status === 'idle' ? 'done' : null
}

const LAYOUTS = { board: 'Board', list: 'List', prs: 'Pull requests' } as const

const SESSION_STATUS = { needs: 'waiting', running: 'running', done: 'done' } as const

/** Runs cut short by a quit that a Restore can pick up: recent ones only, so an old one doesn't keep the button around */
export const restorableRuns = (runs: Run[]): Run[] => runs.filter((run) => run.status === 'interrupted' && Date.now() - (run.endedAt ?? run.startedAt) < DAY_MS)

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
      title="Start the sessions and runs the last quit stopped, and let their agents carry on"
      className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-white"
    >
      <Icon name="history" className="size-3.5" />
      Restore ({count})
    </button>
  )
}

/** Every agent at work in one place: hub runs and agent sessions, by whether they need the user, run, or are done */
export function Board(): React.JSX.Element {
  const host = useHost()
  const sessionsService = host.service('sessions')
  const sessions = useSessions()
  const runs = hubRuns.use()
  const [layout, setLayout] = usePersisted<keyof typeof LAYOUTS>('hub.board.layout', 'board')

  const runCards = runs.flatMap((run): StatusCard[] => {
    const column = runColumn(run)
    if (!column) return []
    const approval = Object.entries(run.nodes).find(([, node]) => node.waiting === 'approval')
    const pullRequest = run.output?.match(PULL_REQUEST)?.[0]
    const links = [
      ...(run.ticket?.url ? [{ label: 'Open ticket', url: run.ticket.url }] : []),
      ...(pullRequest
        ? [
            {
              label: pullRequest.includes('merge_requests') ? 'Open MR' : 'Open PR',
              url: pullRequest
            }
          ]
        : [])
    ]
    return [
      {
        id: `run:${run.id}`,
        column,
        title: runTitle(run.title),
        summary: runSummary(run),
        at: run.endedAt ?? run.startedAt,
        status: shownRun(run),
        open: () => hubSelection.set(`run:${run.id}`),
        links,
        decide: approval ? (approved) => hubApi.decide(run.id, approval[0], approved) : undefined
      }
    ]
  })
  const sessionCards = sessions.flatMap((session): StatusCard[] => {
    const column = isAgent(session.kind) ? sessionColumn(session) : null
    if (!column) return []
    return [
      {
        id: `session:${session.id}`,
        column,
        title: (
          <>
            <Icon name={session.view === 'chat' ? 'comment' : 'terminal'} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
          </>
        ),
        summary: session.worktreePath.split('/').slice(-2).join('/'),
        at: session.startedAt,
        status: SESSION_STATUS[column],
        open: () => sessionsService?.reveal(session.id)
      }
    ]
  })
  const cards = [...runCards, ...sessionCards].sort((a, b) => b.at - a.at)

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
        <div className={`min-h-0 flex-1 overflow-auto p-3 ${layout === 'board' ? 'grid grid-cols-3 items-start gap-3' : 'flex flex-col gap-4'}`}>
          {COLUMNS.map((column) => {
            const shown = cards.filter((card) => card.column === column.id)
            return (
              <section key={column.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border">
                <h3 className="flex items-center justify-between px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {column.label}
                  <span className="tabular-nums">{shown.length}</span>
                </h3>
                {shown.map((card) => (
                  <BoardCard key={card.id} card={card} />
                ))}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
