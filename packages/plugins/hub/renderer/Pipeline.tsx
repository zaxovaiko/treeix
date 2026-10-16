import { useEffect, useReducer, useState } from 'react'
import { type Services, useHost } from '@treeix/sdk'
import { openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { errorMessage, IconButton, usePersisted } from '@treeix/app/ui'
import { latestCardRuns, type PullRequestCard, type Workflow } from '../shared/workflow'
import { BoardCard, runSummary } from './BoardCard'
import { shownRun } from './RunView'
import { hubApi, hubRuns, hubSelection, hubWorkflows } from './store'

type PullRequest = NonNullable<ReturnType<Services['pullRequests']['cached']>>['pullRequests'][number]

const COLUMN = 'flex w-64 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 transition-opacity'
const HEADING = 'flex h-6 items-center gap-1 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase'

const toCard = (pr: PullRequest): PullRequestCard => ({
  url: pr.url,
  title: pr.title,
  number: pr.number,
  repoPath: pr.repoPath,
  sourceBranch: pr.sourceBranch,
  targetBranch: pr.targetBranch
})

/** Your open pull requests in the workspace, as the Pull requests plugin last fetched them; null while that plugin is off */
function useOwnPullRequests(): PullRequest[] | null {
  const host = useHost()
  const service = host.service('pullRequests')
  const repoPaths = host.scopeRepoPaths
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  useEffect(() => service?.subscribe(rerender), [service])
  // Keyed by the paths' text, so a new array of the same repos doesn't refetch
  const scope = repoPaths?.join('\n') ?? ''
  useEffect(() => {
    if (scope) void service?.refresh(scope.split('\n')).catch(() => undefined)
  }, [service, scope])
  if (!service) return null
  return (repoPaths ? (service.cached(repoPaths)?.pullRequests ?? []) : []).filter((pr) => pr.state === 'open' && pr.review?.state === 'yours')
}

/** Pull requests in columns: dropping one on a stage runs that stage's workflow on it, and it sits there from then on */
export function Pipeline(): React.JSX.Element {
  const host = useHost()
  const pullRequests = useOwnPullRequests()
  const runs = hubRuns.use()
  const workflows = hubWorkflows.use()
  const [stored, setStored] = usePersisted<string>('hub.board.stages', '')
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const stageIds = stored.split(',').filter(Boolean)
  const stages = stageIds.flatMap((id) => workflows.filter((workflow) => workflow.id === id))
  const setStages = (ids: string[]): void => setStored(ids.join(','))
  const latest = latestCardRuns(runs)

  if (!pullRequests) return <p className="p-6 text-sm text-muted-foreground">Turn on the Pull requests plugin to work on pull requests from here.</p>

  const move = (pr: PullRequest, stage: Workflow): void => void hubApi.moveCard(toCard(pr), stage.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  const locked = (pr: PullRequest): boolean => latest.get(pr.url)?.status === 'running'
  const columnOf = (pr: PullRequest): string => {
    const stage = latest.get(pr.url)?.workflow.id
    return stage && stageIds.includes(stage) ? stage : 'source'
  }
  const draggedPr = pullRequests.find((pr) => pr.url === dragged)

  const card = (pr: PullRequest): React.JSX.Element => {
    const run = latest.get(pr.url)
    const approval = run && Object.entries(run.nodes).find(([, node]) => node.waiting === 'approval')
    const free = !locked(pr)
    return (
      <div
        key={pr.url}
        draggable={free}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', pr.url)
          event.dataTransfer.effectAllowed = 'move'
          setDragged(pr.url)
        }}
        onDragEnd={() => (setDragged(null), setOver(null))}
        className={free ? 'cursor-grab active:cursor-grabbing' : undefined}
        title={free ? undefined : 'An agent is on it; it moves once the run ends'}
      >
        <BoardCard
          card={{
            id: pr.url,
            title: (
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground tabular-nums">#{pr.number}</span> {pr.title}
              </span>
            ),
            summary: run ? runSummary(run) : `${pr.repoPath.split('/').at(-1)} · ${pr.sourceBranch}`,
            at: run ? (run.endedAt ?? run.startedAt) : Date.parse(pr.updatedAt),
            status: run && shownRun(run),
            open: () => (run ? hubSelection.set(`run:${run.id}`) : host.service('pullRequests')?.open(pr, host)),
            links: [{ label: pr.provider === 'gitlab' ? 'Open MR' : 'Open PR', url: pr.url }],
            decide: approval ? (approved) => hubApi.decide(run.id, approval[0], approved) : undefined,
            moveTo:
              free && stages.length
                ? (event) =>
                    openMenu(
                      event,
                      stages.map((stage) => ({ label: stage.name, run: () => move(pr, stage) }))
                    )
                : undefined
          }}
        />
      </div>
    )
  }

  const addStage = (event: React.MouseEvent): void => {
    const free = workflows.filter((workflow) => !stageIds.includes(workflow.id))
    openMenu(
      event,
      free.length
        ? free.map((workflow) => ({ label: workflow.name, run: () => setStages([...stageIds, workflow.id]) }))
        : [{ label: 'Every workflow is a stage already; make one under Workflows', run: () => undefined, enabled: false }]
    )
  }

  const shown = (column: string): React.JSX.Element[] => pullRequests.filter((pr) => columnOf(pr) === column).map(card)

  return (
    <div className="flex min-h-0 flex-1 items-start gap-3 overflow-auto p-3">
      <section className={`${COLUMN} ring-border ${draggedPr ? 'opacity-50' : ''}`}>
        <h3 className={HEADING}>
          <span className="flex-1">Your pull requests</span>
          <span className="tabular-nums">{shown('source').length}</span>
        </h3>
        {shown('source')}
        {pullRequests.length === 0 && <p className="px-1 text-[11px] text-muted-foreground">No open pull requests of yours in this workspace.</p>}
      </section>
      {stages.map((stage) => {
        const accepts = Boolean(draggedPr)
        return (
          <section
            key={stage.id}
            onDragOver={(event) => {
              if (!accepts) return
              event.preventDefault()
              setOver(stage.id)
            }}
            onDragLeave={(event) => !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) && setOver(null)}
            onDrop={(event) => {
              event.preventDefault()
              if (draggedPr) move(draggedPr, stage)
              setDragged(null)
              setOver(null)
            }}
            className={`${COLUMN} ${over === stage.id ? 'ring-2 ring-primary' : 'ring-border'}`}
          >
            <h3 className={HEADING} title={`Dropping a pull request here runs ${stage.name} on it`}>
              <Icon name="play" className="size-3 shrink-0" />
              <button onClick={() => hubSelection.set(`workflow:${stage.id}`)} className="min-w-0 flex-1 truncate text-left uppercase hover:text-foreground">
                {stage.name}
              </button>
              <span className="tabular-nums">{shown(stage.id).length}</span>
              <IconButton label="Remove stage" onClick={() => setStages(stageIds.filter((id) => id !== stage.id))}>
                <Icon name="close" className="size-3" />
              </IconButton>
            </h3>
            {shown(stage.id)}
            {shown(stage.id).length === 0 && <p className="px-1 text-[11px] text-muted-foreground">Drop a pull request here to run {stage.name} on it.</p>}
          </section>
        )
      })}
      <button
        onClick={addStage}
        className={`${COLUMN} items-center justify-center border border-dashed border-border py-6 text-xs text-muted-foreground ring-0 hover:text-foreground`}
      >
        <Icon name="plus" className="size-3.5" />
        Add workflow stage
        <span className="px-3 text-center text-[11px] text-muted-foreground/70">
          A column for one of your workflows. Drag a pull request onto it to run that workflow on the PR.
        </span>
      </button>
    </div>
  )
}
