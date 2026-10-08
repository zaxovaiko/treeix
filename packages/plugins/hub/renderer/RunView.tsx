import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { errorMessage } from '@treeix/app/ui'
import { Icon, type IconName } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { isWaiting, type NodeRun, type NodeStatus, type Run, type RunEvent, type RunStatus, type WorkflowNode } from '../shared/workflow'
import { AgentAvatar } from './AgentEditor'
import type { Mood } from './Alien'
import { chatIdOf, followRunEvents, hubAgents, hubApi, hubSelection, setConversation, hubRunStep } from './store'

type Shown = NodeStatus | RunStatus | 'waiting'

const runMood = (run: Run): Mood => (isWaiting(run) ? 'waiting' : run.status === 'running' ? 'working' : run.status === 'done' || run.status === 'failed' ? run.status : 'idle')

const STATUS: Record<Shown, { icon: IconName; className: string; label: string }> = {
  pending: { icon: 'history', className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: 'loader', className: 'animate-spin text-sky-400', label: 'Running' },
  done: { icon: 'check', className: 'text-emerald-400', label: 'Done' },
  failed: { icon: 'alert', className: 'text-red-400', label: 'Failed' },
  skipped: { icon: 'close', className: 'text-muted-foreground', label: 'Skipped' },
  cancelled: { icon: 'close', className: 'text-muted-foreground', label: 'Cancelled' },
  interrupted: { icon: 'alert', className: 'text-amber-400', label: 'Interrupted' },
  waiting: { icon: 'comment', className: 'text-amber-400', label: 'Needs you' }
}

/** A step or run held up by the user shows as waiting on them */
export const shownNode = (node: NodeRun): Shown => (node.waiting ? 'waiting' : node.status)
export const shownRun = (run: Run): Shown => (isWaiting(run) ? 'waiting' : run.status)

export const KIND_LABEL: Record<WorkflowNode['kind'], string> = { input: 'Input', agent: 'Agent', merge: 'Merge', condition: 'Condition', approval: 'Approval', output: 'Output' }

export function StatusIcon({ status, className = 'size-3.5' }: { status: Shown; className?: string }): React.JSX.Element {
  return (
    <span title={STATUS[status].label} className="inline-flex shrink-0">
      <Icon name={STATUS[status].icon} className={`${className} ${STATUS[status].className}`} />
    </span>
  )
}

// Within this of the bottom the transcript follows new output, as in a chat
const STICK_PX = 40

const duration = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** A run: its steps, and for the selected one what the agent did or what the step produced */
export function RunView({ run }: { run: Run }): React.JSX.Element {
  const host = useHost()
  const chat = host.service('chat')
  const agents = hubAgents.use()
  const [events, setEvents] = useState<RunEvent[]>([])
  useEffect(() => followRunEvents(run.id, setEvents), [run.id])

  const steps = run.workflow.nodes.filter((node) => node.kind !== 'input')
  const [selectedId, setSelectedId] = useState(
    () =>
      (
        steps.find((node) => `${run.id}:${node.id}` === hubRunStep.get()) ??
        steps.find((node) => run.nodes[node.id].waiting) ??
        steps.find((node) => run.nodes[node.id].status === 'running') ??
        steps.find((node) => node.kind === 'agent') ??
        steps[0]
      )?.id ?? null
  )
  const node = steps.find((step) => step.id === selectedId) ?? null
  const state = node ? run.nodes[node.id] : null
  const nodeEvents = useMemo(() => events.filter((entry) => entry.node === node?.id), [events, node?.id])
  const agentOf = (step: WorkflowNode | undefined) => (step?.kind === 'agent' ? agents.find((agent) => agent.id === step.agent) : undefined)
  const labelOf = (step: WorkflowNode): string => (step.kind === 'agent' ? (agentOf(step)?.name ?? 'Deleted agent') : KIND_LABEL[step.kind])
  const lead = agentOf(steps.find((step) => step.kind === 'agent'))
  const logged = nodeEvents.some((entry) => entry.event.type === 'error')
  const retryable =
    node && state && (run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') && (state.status === 'failed' || state.status === 'cancelled')
  const stepAgent = agentOf(node ?? undefined)
  // The agent's chat opens in its own folder, so a step that ran elsewhere can't be resumed there
  const resumable = stepAgent && state?.sessionId && state.status !== 'running' && node?.kind === 'agent' && (!node.folder || node.folder === stepAgent.folder)
  const continueInChat = (): void => {
    if (!stepAgent || !state?.sessionId) return
    chat?.stop(chatIdOf(stepAgent))
    chat?.forget(chatIdOf(stepAgent))
    setConversation(stepAgent.id, state.sessionId)
    hubSelection.set(`agent:${stepAgent.id}`)
  }
  const retry = (id: string): void => void hubApi.retry(run.id, id).catch((error: unknown) => host.flash(errorMessage(error)))

  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const toBottom = (): void => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }
  // Another run or step opens at its latest message
  useLayoutEffect(() => {
    atBottom.current = true
    toBottom()
  }, [run.id, selectedId])
  useEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => atBottom.current && toBottom())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-1.5 pl-3">
        {lead ? <AgentAvatar agent={lead} size={28} mood={runMood(run)} /> : <Icon name="wand" className="size-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{run.title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <StatusIcon status={shownRun(run)} className="size-3" />
            {[STATUS[shownRun(run)].label, new Date(run.startedAt).toLocaleString(), run.endedAt && duration(run.endedAt - run.startedAt)].filter(Boolean).join(' · ')}
          </div>
        </div>
        {run.status === 'running' && (
          <button onClick={() => hubApi.cancelRun(run.id)} className="h-7 rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
            Cancel
          </button>
        )}
      </header>
      {/* An ask is one agent and its output; the strip earns its place in workflows */}
      {steps.length > 2 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
          {steps.map((step) => {
            const stepRun = run.nodes[step.id]
            return (
              <button
                key={step.id}
                aria-pressed={step === node}
                onClick={() => setSelectedId(step.id)}
                className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-border hover:bg-accent ${step === node ? 'bg-accent' : ''}`}
              >
                <StatusIcon status={shownNode(stepRun)} className="size-3" />
                {labelOf(step)}
                {stepRun.startedAt !== null && stepRun.endedAt !== null && (
                  <span className="text-muted-foreground tabular-nums">{duration(stepRun.endedAt - stepRun.startedAt)}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={content} className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
          {node?.kind === 'agent' && chat ? (
            <chat.Transcript
              events={nodeEvents}
              cwd={node.folder ?? host.defaultCwd}
              live={state?.status === 'running'}
              onAnswer={(requestId, optionId) => hubApi.answer(run.id, node.id, requestId, optionId)}
            />
          ) : (
            state?.output && (
              <div className="text-sm select-text">
                <LazyMarkdown>{state.output}</LazyMarkdown>
              </div>
            )
          )}
          {node?.kind === 'approval' && state?.prompt && (
            <div className="text-sm select-text">
              <LazyMarkdown>{state.prompt}</LazyMarkdown>
            </div>
          )}
          {node && state?.waiting === 'approval' && (
            <div className="flex gap-2">
              <button onClick={() => hubApi.decide(run.id, node.id, true)} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
                Approve
              </button>
              <button onClick={() => hubApi.decide(run.id, node.id, false)} className="h-7 rounded-md px-3 text-xs ring-1 ring-border hover:bg-accent">
                Reject
              </button>
            </div>
          )}
          {state?.status === 'running' && !state.waiting && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="loader" className="size-3.5 animate-spin text-sky-400" />
              Working…
            </div>
          )}
          {state?.error && !logged && <div className="rounded-lg bg-red-400/5 px-3 py-2 text-xs text-red-300 ring-1 ring-red-400/30 select-text">{state.error}</div>}
          {resumable && (
            <button onClick={continueInChat} className="h-7 self-start rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
              Continue in chat
            </button>
          )}
          {retryable && (
            <button onClick={() => retry(node.id)} className="h-7 self-start rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
              Retry from this step
            </button>
          )}
          {state?.usage && (
            <div className="text-[11px] text-muted-foreground">
              {state.usage.used.toLocaleString()} tokens{state.usage.cost !== null && ` · $${state.usage.cost.toFixed(4)}`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
