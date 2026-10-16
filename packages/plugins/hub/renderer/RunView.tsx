import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ISLAND, useHost, PANE_HEADER } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { errorMessage, IconButton, usePersisted } from '@treeix/app/ui'
import { Icon, type IconName } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { decisionText, isWaiting, SOURCED_TITLE, type NodeRun, type NodeStatus, type Run, type RunEvent, type RunStatus, type WorkflowNode } from '../shared/workflow'
import { AgentAvatar } from './AgentEditor'
import { followRunEvents, hubAgents, hubApi, hubBack, hubRunStep, registryId } from './store'

type Shown = NodeStatus | RunStatus | 'waiting'

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

export const KIND_LABEL: Record<WorkflowNode['kind'], string> = {
  input: 'Input',
  agent: 'Agent',
  merge: 'Merge',
  condition: 'Condition',
  approval: 'Approval',
  tool: 'Tool',
  output: 'Output'
}

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

/** Where a finished step's conversation goes on; the first message resumes it as a live chat */
function ReplyBox({ name, inset, onSend }: { name: string; inset: boolean; onSend: (message: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const send = (): void => {
    if (!draft.trim()) return
    onSend(draft.trim())
    setDraft('')
  }
  return (
    <div className={`shrink-0 px-4 pb-3 ${inset ? 'pr-60' : ''}`}>
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border focus-within:ring-primary">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            send()
          }}
          rows={1}
          aria-label={`Reply to ${name}`}
          placeholder={`Reply to ${name} to keep going`}
          className="max-h-40 min-h-7 flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-muted-foreground/60"
        />
        <IconButton label="Send" disabled={!draft.trim()} onClick={send}>
          <Icon name="arrowRight" className="size-3.5" />
        </IconButton>
      </div>
    </div>
  )
}

/** A run: its steps, and for the selected one what the agent did or what the step produced */
export function RunView({ run }: { run: Run }): React.JSX.Element {
  const host = useHost()
  const chat = host.service('chat')
  const agents = hubAgents.use()
  const [events, setEvents] = useState<RunEvent[]>([])
  useEffect(() => followRunEvents(run.id, setEvents), [run.id])

  const steps = run.workflow.nodes.filter((node) => node.kind !== 'input')
  const sidebar = steps.length > 2
  const [openSteps, setOpenSteps] = usePersisted<boolean>('hub.run.steps', true)
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
  // Two steps of one agent tell apart by the subagent the second borrows
  const labelOf = (step: WorkflowNode): string =>
    step.kind === 'agent' ? [agentOf(step)?.name ?? 'Deleted agent', step.subagent?.split('/').pop()?.replace(/\.md$/, '')].filter(Boolean).join(' · ') : KIND_LABEL[step.kind]
  const lead = agentOf(steps.find((step) => step.kind === 'agent'))
  const logged = nodeEvents.some((entry) => entry.event.type === 'error')
  const retryable =
    node && state && (run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') && (state.status === 'failed' || state.status === 'cancelled')
  const stepAgent = agentOf(node ?? undefined)
  const persona = useAgents().find((entry) => stepAgent && entry.id === registryId(stepAgent))
  // A finished step's conversation carries on as a chat of its own, so the agent's own chat is left alone
  const chatId = `run:${run.id}:${node?.id ?? ''}`
  const chatting = useSyncExternalStore(chat?.subscribe ?? (() => () => undefined), () => chat?.agent(chatId) != null)
  const continuable = node?.kind === 'agent' && stepAgent && persona?.chat && state?.sessionId && state.status !== 'running'
  const reply = (message: string): void => {
    if (!chat || !continuable || !persona.chat || !state.sessionId) return
    const cwd = node.folder ?? stepAgent.folder ?? host.defaultCwd
    // The chat shows a failed start itself
    chat.start(chatId, { agent: persona.id, ...persona.chat, cwd, resume: state.sessionId }).then(
      () => chat.send(chatId, message),
      () => undefined
    )
  }
  const report = (action: Promise<unknown>): void => void action.catch((error: unknown) => host.flash(errorMessage(error)))

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
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The steps island floats over the header's right end, so the header ends before it */}
      <header className={`${PANE_HEADER} gap-2.5 pl-1.5 ${sidebar && openSteps ? 'pr-60' : 'pr-1.5'}`}>
        <IconButton label="Back" onClick={hubBack}>
          <Icon name="arrowLeft" className="size-3.5" />
        </IconButton>
        {lead ? <AgentAvatar agent={lead} size={28} /> : <Icon name="wand" className="size-4 text-muted-foreground" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-[13px] leading-none font-medium">{SOURCED_TITLE.exec(run.title)?.[3] || run.title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] leading-none text-muted-foreground">
            <StatusIcon status={shownRun(run)} className="size-3" />
            {[STATUS[shownRun(run)].label, new Date(run.startedAt).toLocaleString(), run.endedAt && duration(run.endedAt - run.startedAt)].filter(Boolean).join(' · ')}
          </div>
        </div>
        {run.status === 'running' && (
          <button onClick={() => hubApi.cancelRun(run.id)} className="h-7 rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
            Cancel
          </button>
        )}
        {sidebar && !openSteps && (
          <IconButton label="Show the steps" onClick={() => setOpenSteps(true)}>
            <Icon name="panel" className="size-3.5" />
          </IconButton>
        )}
      </header>
      {chat && chatting ? (
        <div className={`flex min-h-0 flex-1 flex-col ${sidebar && openSteps ? 'pr-60' : ''}`}>
          <chat.View chatId={chatId} />
        </div>
      ) : (
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
          }}
          className={`min-h-0 flex-1 overflow-y-auto ${sidebar && openSteps ? 'pr-60' : ''}`}
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
            {state?.decision && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground select-text">
                <Icon name={state.decision.approved ? 'check' : 'close'} className="mt-px size-3.5 shrink-0" />
                {decisionText(state.decision)}
              </p>
            )}
            {state?.status === 'running' && !state.waiting && (
              <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon name="loader" className="size-3.5 animate-spin text-sky-400" />
                Working…
              </div>
            )}
            {state?.error && !logged && <div className="rounded-lg bg-red-400/5 px-3 py-2 text-xs text-red-300 ring-1 ring-red-400/30 select-text">{state.error}</div>}
            {retryable && (
              <button onClick={() => report(hubApi.retry(run.id, node.id))} className="h-7 self-start rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
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
      )}
      {continuable && !chatting && <ReplyBox name={stepAgent.name} inset={sidebar && openSteps} onSend={reply} />}
      {/* An ask is one agent and its output; the step list earns its own island in workflows */}
      {sidebar && openSteps && (
        <aside className={`absolute top-2 right-2 bottom-2 z-20 flex w-56 flex-col ${ISLAND}`}>
          <div className={`${PANE_HEADER} gap-2 pr-1.5 pl-3`}>
            <span className="flex-1 text-[11px] font-semibold text-foreground">Steps</span>
            <IconButton label="Hide the steps" onClick={() => setOpenSteps(false)}>
              <Icon name="panel" className="size-3.5" />
            </IconButton>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5 pt-0">
            {steps.map((step, index) => {
              const stepRun = run.nodes[step.id]
              const shown = shownNode(stepRun)
              const untouched = shown === 'pending' || shown === 'skipped'
              const reached = (at: number): boolean => run.nodes[steps[at].id].status === 'done'
              return (
                <button
                  key={step.id}
                  aria-pressed={step === node}
                  onClick={() => setSelectedId(step.id)}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent ${step === node ? 'bg-accent' : untouched ? 'text-muted-foreground' : ''}`}
                >
                  <span className="relative flex w-5 shrink-0 items-center justify-center self-stretch">
                    {index > 0 && <span className={`absolute top-0 h-[calc(50%-10px)] w-px ${reached(index - 1) ? 'bg-emerald-400/60' : 'bg-border'}`} />}
                    {index < steps.length - 1 && <span className={`absolute bottom-0 h-[calc(50%-10px)] w-px ${reached(index) ? 'bg-emerald-400/60' : 'bg-border'}`} />}
                    <span
                      className={`flex size-5 items-center justify-center rounded-full ring-1 ${untouched ? 'ring-border' : 'ring-current/30'} ${STATUS[shown].className.replace('animate-spin', '')}`}
                    >
                      <StatusIcon status={shown} className="size-3" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{labelOf(step)}</span>
                  {stepRun.startedAt !== null && stepRun.endedAt !== null && (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{duration(stepRun.endedAt - stepRun.startedAt)}</span>
                  )}
                </button>
              )
            })}
          </div>
        </aside>
      )}
    </div>
  )
}
