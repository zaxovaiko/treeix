import '@xyflow/react/dist/style.css'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  type Edge as FlowEdge,
  Handle,
  type Node as FlowNode,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  useReactFlow
} from '@xyflow/react'
import { ISLAND, usePanels, useHost, Zone } from '@treeix/sdk'
import { actionKeys } from '@treeix/shared/keymap'
import { Icon, type IconName } from '@treeix/app/Icon'
import { timeAgo } from '@treeix/app/time'
import { errorMessage, IconButton } from '@treeix/app/ui'
import { Picker, Select } from '@treeix/app/Picker'
import { ancestors, type Problem, validate } from '../shared/validate'
import { ASK_TIMEOUT_MIN, type NodeRun, type Workflow, type WorkflowNode } from '../shared/workflow'
import { AgentAvatar, Schedules } from './AgentEditor'
import { KIND_LABEL, shownNode, StatusIcon } from './RunView'
import { asking, hubAgents, hubApi, hubRunStep, hubRuns, hubSelection } from './store'

type StepNode = FlowNode<{ step: WorkflowNode }, 'step'>

const SAVE_DELAY_MS = 500
const COLUMN = 260
const ROW = 120
const FIELD = 'w-full rounded-md border border-input bg-muted px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary'
const LABEL = 'flex flex-col gap-1.5 text-xs text-muted-foreground'
const KIND_ICON: Record<WorkflowNode['kind'], IconName> = { input: 'pointer', agent: 'user', merge: 'layers', condition: 'branch', approval: 'lock', output: 'check' }
const TESTS = { contains: 'contains', equals: 'equals', regex: 'matches the pattern', empty: 'is empty' } as const satisfies Record<
  Extract<WorkflowNode, { kind: 'condition' }>['test'],
  string
>
// Follows the app theme instead of React Flow's own light colors
const THEME = {
  '--xy-edge-stroke': 'var(--color-muted-foreground)',
  '--xy-edge-stroke-selected': 'var(--color-primary)',
  '--xy-connectionline-stroke': 'var(--color-primary)',
  '--xy-handle-background-color': 'var(--color-muted-foreground)',
  '--xy-handle-border-color': 'var(--color-popover)',
  '--xy-background-pattern-dots-color': 'var(--color-border)',
  '--xy-controls-button-background-color': 'var(--color-popover)',
  '--xy-controls-button-background-color-hover': 'var(--color-accent)',
  '--xy-controls-button-color': 'var(--color-foreground)',
  '--xy-controls-button-border-color': 'var(--color-border)',
  '--xy-attribution-background-color': 'transparent'
} as React.CSSProperties

/** What the canvas cards show besides their step: the last run's state of each and what is wrong with it */
const CanvasContext = createContext<{ run: Record<string, NodeRun>; problems: Map<string, string[]> }>({ run: {}, problems: new Map() })

const toFlow = (workflow: Workflow): { nodes: StepNode[]; edges: FlowEdge[] } => ({
  nodes: workflow.nodes.map((step, index) => ({
    id: step.id,
    type: 'step',
    position: workflow.layout[step.id] ?? { x: index * COLUMN, y: 0 },
    data: { step },
    deletable: step.kind !== 'input'
  })),
  edges: workflow.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to, sourceHandle: edge.branch }))
})

const fromFlow = (base: Workflow, name: string, nodes: StepNode[], edges: FlowEdge[]): Workflow => ({
  ...base,
  name,
  nodes: nodes.map((node) => node.data.step),
  edges: edges.map((edge) => ({
    id: edge.id,
    from: edge.source,
    to: edge.target,
    branch: edge.sourceHandle === 'true' || edge.sourceHandle === 'false' ? edge.sourceHandle : null
  })),
  layout: Object.fromEntries(nodes.map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]))
})

function blankStep(kind: Exclude<WorkflowNode['kind'], 'input'>, id: string, agent: string): WorkflowNode {
  switch (kind) {
    case 'agent':
      return { id, kind, agent, prompt: '{{prev}}', folder: null, retries: 0, onError: 'stop', timeoutMin: ASK_TIMEOUT_MIN }
    case 'condition':
      return { id, kind, source: '{{prev}}', test: 'contains', value: '' }
    case 'approval':
      return { id, kind, message: 'Go on with {{prev}}?' }
    case 'merge':
    case 'output':
      return { id, kind, template: '{{prev}}' }
  }
}

function StepCard({ id, data: { step }, selected }: NodeProps<StepNode>): React.JSX.Element {
  const { run, problems } = useContext(CanvasContext)
  const agent = hubAgents.use().find((candidate) => step.kind === 'agent' && candidate.id === step.agent)
  const state = run[id]
  const issues = problems.get(id)
  const title = step.kind === 'agent' ? (agent?.name ?? 'Pick an agent') : KIND_LABEL[step.kind]
  const detail =
    step.kind === 'input'
      ? (step.schedules ?? [])
          .filter((schedule) => schedule.enabled)
          .map((schedule) => [schedule.cron, schedule.command].filter(Boolean).join(' · '))
          .join('; ') || 'What the run starts with'
      : step.kind === 'agent'
        ? step.prompt
        : step.kind === 'condition'
          ? `${step.source} ${TESTS[step.test]} ${step.test === 'empty' ? '' : step.value}`
          : step.kind === 'approval'
            ? step.message
            : step.template

  return (
    <div
      title={issues?.join('\n')}
      className={`w-56 rounded-lg border bg-popover py-2 pl-3 text-xs shadow-sm ${step.kind === 'condition' ? 'pr-9' : 'pr-3'} ${issues ? 'border-red-400/60' : 'border-border'} ${selected ? 'ring-1 ring-primary' : ''}`}
    >
      {step.kind !== 'input' && <Handle type="target" position={Position.Left} className="size-2.5!" />}
      <div className="flex items-center gap-2">
        {agent ? <AgentAvatar agent={agent} size={20} /> : <Icon name={KIND_ICON[step.kind]} className="size-3.5 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {state && state.status !== 'pending' && <StatusIcon status={shownNode(state)} />}
      </div>
      {detail.trim() && <div className="mt-1 line-clamp-2 break-words text-muted-foreground">{detail}</div>}
      {step.kind === 'condition' ? (
        <>
          <Handle id="true" type="source" position={Position.Right} className="size-2.5!" style={{ top: '35%' }} />
          <Handle id="false" type="source" position={Position.Right} className="size-2.5!" style={{ top: '75%' }} />
          <span className="absolute top-[35%] right-2 -translate-y-1/2 text-[10px] text-emerald-400">yes</span>
          <span className="absolute top-[75%] right-2 -translate-y-1/2 text-[10px] text-red-400">no</span>
        </>
      ) : (
        step.kind !== 'output' && <Handle type="source" position={Position.Right} className="size-2.5!" />
      )}
    </div>
  )
}

const NODE_TYPES = { step: StepCard }

/** A template box with a menu that appends a reference to the input, what flows in, or an earlier step */
function TemplateField({
  label,
  value,
  sources,
  onChange
}: {
  label: string
  value: string
  sources: { id: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const references = [
    { id: 'input', label: "The run's input" },
    { id: 'prev', label: 'What flows in' },
    ...sources.map((source) => ({ id: `nodes.${source.id}.output`, label: `Output of ${source.label}` }))
  ]
  return (
    <div className={LABEL}>
      <span className="flex items-center justify-between">
        {label}
        <Picker
          title={`Insert into ${label}`}
          open={open}
          onOpenChange={setOpen}
          current={null}
          placeholder="Search…"
          align="right"
          onPick={(reference) => onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}{{${reference}}}`)}
          options={references.map((reference) => ({ ...reference, section: '', render: <span className="truncate">{reference.label}</span> }))}
          trigger={
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              Insert…
              <Icon name="chevron" className="size-3 rotate-90" />
            </span>
          }
        />
      </span>
      <textarea aria-label={label} rows={5} value={value} onChange={(event) => onChange(event.target.value)} className={`${FIELD} resize-y font-mono text-xs`} />
    </div>
  )
}

function Inspector({
  step,
  sources,
  onChange,
  onDelete
}: {
  step: WorkflowNode
  sources: { id: string; label: string }[]
  onChange: (step: WorkflowNode) => void
  onDelete: () => void
}): React.JSX.Element {
  const agents = hubAgents.use()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">{KIND_LABEL[step.kind]}</span>
        {step.kind !== 'input' && (
          <IconButton label="Delete step" onClick={onDelete}>
            <Icon name="trash" className="size-3.5" />
          </IconButton>
        )}
      </div>
      {step.kind === 'input' && (
        <>
          <p className="text-xs text-muted-foreground">The text you run the workflow with, or a schedule starts it with. Steps read it as {'{{input}}'}.</p>
          <Schedules workflow schedules={step.schedules ?? []} onChange={(schedules) => onChange({ ...step, schedules })} />
        </>
      )}
      {step.kind === 'agent' && (
        <>
          <div className={LABEL}>
            Agent
            <Select
              title="The agent this step asks"
              value={agents.some((agent) => agent.id === step.agent) ? step.agent : null}
              placeholder="Pick an agent"
              options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
              onChange={(agent) => onChange({ ...step, agent })}
            />
          </div>
          <TemplateField label="Prompt" value={step.prompt} sources={sources} onChange={(prompt) => onChange({ ...step, prompt })} />
          <label className={LABEL}>
            Folder
            <input
              value={step.folder ?? ''}
              onChange={(event) => onChange({ ...step, folder: event.target.value.trim() || null })}
              placeholder="The agent's own"
              className={`${FIELD} h-8 font-mono text-xs`}
            />
          </label>
          <div className="flex gap-2">
            <label className={`${LABEL} flex-1`}>
              Retries
              <input
                type="number"
                min={0}
                max={5}
                value={step.retries}
                onChange={(event) => onChange({ ...step, retries: Math.max(0, Number(event.target.value) || 0) })}
                className={`${FIELD} h-8`}
              />
            </label>
            <label className={`${LABEL} flex-1`}>
              Timeout, min
              <input
                type="number"
                min={1}
                value={step.timeoutMin}
                onChange={(event) => onChange({ ...step, timeoutMin: Math.max(1, Number(event.target.value) || 1) })}
                className={`${FIELD} h-8`}
              />
            </label>
          </div>
          <div className={LABEL}>
            If it fails
            <Select
              title="If it fails"
              value={step.onError}
              options={[
                { value: 'stop', label: 'Stop the run' },
                { value: 'continue', label: 'Go on without its output' }
              ]}
              onChange={(onError) => onChange({ ...step, onError: onError === 'continue' ? 'continue' : 'stop' })}
            />
          </div>
        </>
      )}
      {step.kind === 'approval' && (
        <>
          <TemplateField label="Message" value={step.message} sources={sources} onChange={(message) => onChange({ ...step, message })} />
          <p className="text-xs text-muted-foreground">The run waits here until you approve it from the run's page; what came in goes on. Reject fails the run.</p>
        </>
      )}
      {(step.kind === 'merge' || step.kind === 'output') && (
        <TemplateField label="Template" value={step.template} sources={sources} onChange={(template) => onChange({ ...step, template })} />
      )}
      {step.kind === 'condition' && (
        <>
          <TemplateField label="Check" value={step.source} sources={sources} onChange={(source) => onChange({ ...step, source })} />
          <div className={LABEL}>
            Test
            <Select
              title="Test"
              value={step.test}
              options={Object.entries(TESTS).map(([test, label]) => ({ value: test, label }))}
              onChange={(value) => {
                const test = Object.keys(TESTS).find((key): key is keyof typeof TESTS => key === value)
                if (test) onChange({ ...step, test })
              }}
            />
          </div>
          {step.test !== 'empty' && (
            <label className={LABEL}>
              Value
              <input value={step.value} onChange={(event) => onChange({ ...step, value: event.target.value })} className={`${FIELD} h-8 font-mono text-xs`} />
            </label>
          )}
          <p className="text-xs text-muted-foreground">Steps on the yes side run when the test holds, the no side when it doesn't.</p>
        </>
      )}
    </div>
  )
}

const STEP_KINDS = ['agent', 'merge', 'condition', 'approval', 'output'] as const
const TOOL = 'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs hover:bg-accent'

/** Steps to add and the view's controls, one island at the bottom of the canvas */
function Toolbar({ onAdd, onUndo }: { onAdd: (kind: (typeof STEP_KINDS)[number]) => void; onUndo: () => void }): React.JSX.Element {
  const flow = useReactFlow()
  return (
    <Panel position="bottom-center" className={`flex items-center gap-0.5 p-1 ${ISLAND}`}>
      {STEP_KINDS.map((kind) => (
        <button key={kind} onClick={() => onAdd(kind)} className={TOOL}>
          <Icon name={KIND_ICON[kind]} className="size-3.5" />
          {KIND_LABEL[kind]}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-border" />
      <IconButton label="Undo (⌘Z)" onClick={onUndo}>
        <Icon name="undo" className="size-3.5" />
      </IconButton>
      <IconButton label="Fit view" onClick={() => void flow.fitView(FIT)}>
        <Icon name="focus" className="size-3.5" />
      </IconButton>
    </Panel>
  )
}

// Clear of the list and inspector islands
const FIT = { maxZoom: 1, minZoom: 0.5, padding: { left: '300px', right: '300px', top: '40px', bottom: '80px' } } as const

/** The workflow on a canvas: steps to add, connect and fill in, saved as you go, with the last run's state on each */
export function WorkflowView({ workflow }: { workflow: Workflow }): React.JSX.Element {
  const host = useHost()
  const agents = hubAgents.use()
  // ponytail: the open canvas owns the workflow, so its own saves coming back don't reset it and an edit from another window shows after reopening
  const [opened] = useState(workflow)
  const [name, setName] = useState(workflow.name)
  const [nodes, setNodes] = useState(() => toFlow(workflow).nodes)
  const [edges, setEdges] = useState(() => toFlow(workflow).edges)
  const draft = useMemo(() => fromFlow(opened, name, nodes, edges), [opened, name, nodes, edges])
  const problems: Problem[] = useMemo(
    () =>
      validate(
        draft,
        agents.map((agent) => agent.id)
      ),
    [draft, agents]
  )
  const lastRun = hubRuns.use().find((run) => run.kind === 'workflow' && run.workflow.id === workflow.id)
  const canvas = useMemo(() => {
    const byNode = new Map<string, string[]>()
    for (const problem of problems) if (problem.node) byNode.set(problem.node, [...(byNode.get(problem.node) ?? []), problem.message])
    return { run: lastRun?.nodes ?? {}, problems: byNode }
  }, [problems, lastRun])

  // Each save is an undo step, so typing and dragging undo in pauses rather than per keystroke
  const saved = useRef(opened)
  const history = useRef<{ past: Workflow[]; future: Workflow[] }>({ past: [], future: [] })
  const deleted = useRef(false)
  const write = (version: Workflow): Promise<void> => {
    saved.current = version
    return hubApi.saveWorkflow({ ...version, updatedAt: Date.now() }).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  const commit = (): Promise<void> => {
    if (deleted.current || content === JSON.stringify(saved.current)) return Promise.resolve()
    history.current = { past: [...history.current.past, saved.current], future: [] }
    return write(draft)
  }
  // Adding, removing or connecting a step is an undo step of its own, not folded into edits still waiting to save
  const checkpoint = (): void => void commit()
  // Selecting or measuring a step makes a new draft with the same content; only content restarts the wait
  const content = JSON.stringify(draft)
  const latestCommit = useRef(commit)
  useEffect(() => {
    latestCommit.current = commit
    const timer = setTimeout(commit, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [content])
  useEffect(() => () => void latestCommit.current(), [])

  const restore = (version: Workflow): void => {
    const flow = toFlow(version)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    setName(version.name)
    void write(version)
  }
  const undo = (): void => {
    void commit()
    const { past, future } = history.current
    const previous = past.at(-1)
    if (!previous) return
    history.current = { past: past.slice(0, -1), future: [saved.current, ...future] }
    restore(previous)
  }
  const redo = (): void => {
    void commit()
    const { past, future } = history.current
    const [next, ...rest] = future
    if (!next) return
    history.current = { past: [...past, saved.current], future: rest }
    restore(next)
  }

  // Deleting a step or clicking a problem leaves focus on the page, so the keys are heard there too; text fields keep their own undo
  const root = useRef<HTMLDivElement>(null)
  const historyKeys = useRef({ undo, redo })
  useEffect(() => {
    historyKeys.current = { undo, redo }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!root.current?.checkVisibility() || target?.closest('input, textarea, select, [contenteditable]') || (target !== document.body && !root.current.contains(target))) return
      event.preventDefault()
      if (event.shiftKey) historyKeys.current.redo()
      else historyKeys.current.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selected = nodes.find((node) => node.selected) ?? null
  const labelOf = (step: WorkflowNode): string =>
    step.kind === 'agent' ? (agents.find((agent) => agent.id === step.agent)?.name ?? step.id) : `${KIND_LABEL[step.kind]} (${step.id})`
  const sources = selected
    ? [...ancestors(draft, selected.id)].flatMap((id) => {
        const step = draft.nodes.find((node) => node.id === id)
        return step && step.kind !== 'input' ? [{ id, label: labelOf(step) }] : []
      })
    : []

  const connectable = (connection: Connection | FlowEdge): boolean => connection.source !== connection.target && !ancestors(draft, connection.source).has(connection.target)

  /** Adds a step after the selected one, taking over where it led unless that's a condition, whose sides stay as they are; a new condition passes on along its yes side */
  const add = (kind: Exclude<WorkflowNode['kind'], 'input'>): void => {
    let count = 1
    while (nodes.some((node) => node.id === `${kind}-${count}`)) count++
    const id = `${kind}-${count}`
    checkpoint()
    const after = selected && selected.data.step.kind !== 'output' ? selected : null
    const position = after ? { x: after.position.x + COLUMN, y: after.position.y } : { x: Math.max(0, ...nodes.map((node) => node.position.x)) + COLUMN, y: 0 }
    while (nodes.some((node) => Math.abs(node.position.x - position.x) < COLUMN * 0.9 && Math.abs(node.position.y - position.y) < ROW * 0.9)) position.y += ROW
    setNodes([...nodes.map((node) => ({ ...node, selected: false })), { id, type: 'step', position, data: { step: blankStep(kind, id, agents[0]?.id ?? '') }, selected: true }])
    if (!after) return
    const branching = after.data.step.kind === 'condition'
    const moved =
      branching || kind === 'output' ? edges : edges.map((edge) => (edge.source === after.id ? { ...edge, source: id, sourceHandle: kind === 'condition' ? 'true' : null } : edge))
    setEdges([...moved, { id: crypto.randomUUID(), source: after.id, target: id, sourceHandle: branching ? 'true' : null }])
  }

  const update = (step: WorkflowNode): void => setNodes(nodes.map((node) => (node.id === step.id ? { ...node, data: { step } } : node)))
  const removeStep = (id: string): void => {
    checkpoint()
    setNodes(nodes.filter((node) => node.id !== id))
    setEdges(edges.filter((edge) => edge.source !== id && edge.target !== id))
  }

  const run = (): void => {
    void commit().then(() => asking.set({ target: `workflow:${workflow.id}`, openRun: false }))
  }
  const remove = (): void => {
    if (!window.confirm(`Delete ${name}?`)) return
    deleted.current = true
    hubApi.removeWorkflow(workflow.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  const panels = usePanels('hub')
  const runButton = (
    <button
      onClick={run}
      disabled={problems.length > 0}
      title={problems.map((problem) => problem.message).join('\n') || undefined}
      className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-50"
    >
      <Icon name="wand" className="size-3.5" />
      Run
    </button>
  )
  const inspectorToggle = (
    <IconButton label={`${panels.inspector ? 'Hide' : 'Show'} the inspector (${actionKeys('panel.inspector')})`} onClick={() => panels.toggle('inspector')}>
      <Icon name="panel" className="size-3.5 -scale-x-100" />
    </IconButton>
  )

  return (
    <div ref={root} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-1 outline-none">
      <CanvasContext value={canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes) => {
            if (changes.some((change) => change.type === 'remove')) checkpoint()
            setNodes((current) => applyNodeChanges(changes, current))
          }}
          onEdgesChange={(changes) => {
            if (changes.some((change) => change.type === 'remove')) checkpoint()
            setEdges((current) => applyEdgeChanges(changes, current))
          }}
          onConnect={(connection) => {
            checkpoint()
            setEdges((current) => addEdge({ ...connection, id: crypto.randomUUID() }, current))
          }}
          isValidConnection={connectable}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          fitViewOptions={FIT}
          style={THEME}
        >
          <Background gap={20} />
          <Toolbar onAdd={add} onUndo={undo} />
        </ReactFlow>
      </CanvasContext>
      {panels.inspector ? (
        // The workflow's name and Run on top, the selected step below
        <Zone id="inspector" className={`absolute top-2 right-2 bottom-2 z-20 w-72 ${ISLAND}`}>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <input
              aria-label="Workflow name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
            />
            <IconButton label="Delete workflow" onClick={remove}>
              <Icon name="trash" className="size-3.5" />
            </IconButton>
            {inspectorToggle}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            {lastRun && (
              <button
                onClick={() => hubSelection.set(`run:${lastRun.id}`)}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <StatusIcon status={lastRun.status} className="size-3" />
                Last run {timeAgo(new Date(lastRun.startedAt).toISOString())}
              </button>
            )}
            <span className="flex-1" />
            {runButton}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selected && lastRun && (lastRun.nodes[selected.id]?.status ?? 'pending') !== 'pending' && (
              <button
                onClick={() => (hubRunStep.set(`${lastRun.id}:${selected.id}`), hubSelection.set(`run:${lastRun.id}`))}
                className="mb-3 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-border hover:bg-accent"
              >
                <StatusIcon status={shownNode(lastRun.nodes[selected.id])} className="size-3" />
                Open the step's log
              </button>
            )}
            {selected ? (
              <Inspector key={selected.id} step={selected.data.step} sources={sources} onChange={update} onDelete={() => removeStep(selected.id)} />
            ) : problems.length ? (
              <div className="flex flex-col gap-2 text-xs">
                <span className="text-sm font-medium">Before it can run</span>
                {problems.map((problem, index) => {
                  const step = draft.nodes.find((node) => node.id === problem.node)
                  return (
                    <button
                      key={index}
                      disabled={!problem.node}
                      onClick={() => setNodes(nodes.map((node) => ({ ...node, selected: node.id === problem.node })))}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:hover:bg-transparent"
                    >
                      <Icon name="alert" className="mt-px size-3.5 shrink-0 text-red-400" />
                      {step && <span className="font-medium">{labelOf(step)}:</span>}
                      <span className="text-muted-foreground">{problem.message}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select a step to edit it, or add one with the buttons on the canvas; it goes after the selected step. Drag from a step's right edge to another to connect them, and
                press Backspace to delete what's selected. ⌘Z undoes.
              </p>
            )}
          </div>
        </Zone>
      ) : (
        // Folded, it keeps the name and Run in reach
        <div className={`absolute top-2 right-2 z-20 flex h-10 items-center gap-1 pr-1 pl-3 ${ISLAND}`}>
          <span className="mr-1 max-w-48 truncate text-xs font-medium">{name}</span>
          {runButton}
          {inspectorToggle}
        </div>
      )}
    </div>
  )
}
