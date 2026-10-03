import { useEffect, useMemo, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Icon, type IconName } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import type { NodeStatus, Run, RunEvent, RunStatus, WorkflowNode } from '../shared/workflow'
import { AgentAvatar } from './AgentEditor'
import { followRunEvents, hubAgents, hubApi } from './store'

const STATUS: Record<NodeStatus | RunStatus, { icon: IconName; className: string; label: string }> = {
  pending: { icon: 'history', className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: 'loader', className: 'animate-spin text-sky-400', label: 'Running' },
  done: { icon: 'check', className: 'text-emerald-400', label: 'Done' },
  failed: { icon: 'alert', className: 'text-red-400', label: 'Failed' },
  skipped: { icon: 'close', className: 'text-muted-foreground', label: 'Skipped' },
  cancelled: { icon: 'close', className: 'text-muted-foreground', label: 'Cancelled' },
  interrupted: { icon: 'alert', className: 'text-amber-400', label: 'Interrupted' }
}

const KIND_LABEL: Record<WorkflowNode['kind'], string> = { input: 'Input', agent: 'Agent', merge: 'Merge', condition: 'Condition', output: 'Output' }

export function StatusIcon({ status, className = 'size-3.5' }: { status: NodeStatus | RunStatus; className?: string }): React.JSX.Element {
  return (
    <span title={STATUS[status].label} className="inline-flex shrink-0">
      <Icon name={STATUS[status].icon} className={`${className} ${STATUS[status].className}`} />
    </span>
  )
}

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
  const [selectedId, setSelectedId] = useState(() => (steps.find((node) => node.kind === 'agent') ?? steps[0])?.id ?? null)
  const node = steps.find((step) => step.id === selectedId) ?? null
  const state = node ? run.nodes[node.id] : null
  const nodeEvents = useMemo(() => events.filter((entry) => entry.node === node?.id), [events, node?.id])
  const agentOf = (step: WorkflowNode | undefined) => (step?.kind === 'agent' ? agents.find((agent) => agent.id === step.agent) : undefined)
  const labelOf = (step: WorkflowNode): string => (step.kind === 'agent' ? (agentOf(step)?.name ?? 'Deleted agent') : KIND_LABEL[step.kind])
  const lead = agentOf(steps.find((step) => step.kind === 'agent'))
  const logged = nodeEvents.some((entry) => entry.event.type === 'error')

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-1.5 pl-3">
        {lead ? <AgentAvatar agent={lead} className="size-7 text-sm" /> : <Icon name="wand" className="size-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{run.title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <StatusIcon status={run.status} className="size-3" />
            {[STATUS[run.status].label, new Date(run.startedAt).toLocaleString(), run.endedAt && duration(run.endedAt - run.startedAt)].filter(Boolean).join(' · ')}
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
                <StatusIcon status={stepRun.status} className="size-3" />
                {labelOf(step)}
                {stepRun.startedAt !== null && stepRun.endedAt !== null && <span className="text-muted-foreground tabular-nums">{duration(stepRun.endedAt - stepRun.startedAt)}</span>}
              </button>
            )
          })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
          {node?.kind === 'agent' && chat ? (
            <chat.Transcript events={nodeEvents} cwd={node.folder ?? host.defaultCwd} onAnswer={(requestId, optionId) => hubApi.answer(run.id, node.id, requestId, optionId)} />
          ) : (
            state?.output && (
              <div className="text-sm select-text">
                <LazyMarkdown>{state.output}</LazyMarkdown>
              </div>
            )
          )}
          {state?.status === 'running' && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="loader" className="size-3.5 animate-spin text-sky-400" />
              Working…
            </div>
          )}
          {state?.error && !logged && <div className="rounded-lg bg-red-400/5 px-3 py-2 text-xs text-red-300 ring-1 ring-red-400/30 select-text">{state.error}</div>}
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
