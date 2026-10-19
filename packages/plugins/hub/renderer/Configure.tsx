import { Fragment, useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { BotAvatar, type BotLook } from '@treeix/app/BotAvatar'
import { Icon, type IconName } from '@treeix/app/Icon'
import { Switch } from '@treeix/app/settingsUi'
import { botsPageOf, type BotsSettingsPage, BotsWindowSettings, PluginPage, shownBotsPages } from '@treeix/app/SettingsView'
import { BrandMark } from '@treeix/app/brandMarks'
import { onSettingsPage, type PageId, pluginOf, takeRequestedPage } from '@treeix/app/settingsNav'
import { setPluginEnabled, usePlugins } from '@treeix/app/plugins'
import { errorMessage, useChromeless } from '@treeix/app/ui'
import { isCron } from '../shared/cron'
import { roleName, type Subagent, type SubagentRole, subagentRoles } from '../shared/subagents'
import { ticketWorkflow } from '../shared/templates'
import { type HubAgent, MAX_TIMEOUT_MIN, type Schedule } from '../shared/types'
import { validate } from '../shared/validate'
import {
  type AgentNode,
  CODING_AGENTS,
  isCodingAgent,
  MAX_AT_ONCE,
  MAX_SLACK_INTERVAL_MIN,
  type ProjectRule,
  SLACK_EVENT,
  SLACK_TRIGGER,
  type SlackTrigger,
  WATCH_AT_ONCE,
  WATCH_QUERY,
  type Watch,
  type Workflow,
  type WorkflowNode
} from '../shared/workflow'
import { AgentEditor, FolderField, WholeNumber } from './AgentEditor'
import { deleteAgent, hubAgents, hubApi, hubWorkflows } from './store'

const FILLED = 'flex h-7 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-on-foreground disabled:opacity-40'
const OUTLINED = 'flex h-7 max-w-full shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full px-3 text-xs ring-1 ring-input hover:bg-accent disabled:opacity-40'
const CARD = 'flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-border'
const WATCHES: Record<Watch['source'], { icon: IconName; label: string }> = {
  jira: { icon: 'ticket', label: 'Jira tickets match' },
  notion: { icon: 'bookOpen', label: 'Notion tasks match' }
}
const STEP_KIND: Partial<Record<WorkflowNode['kind'], string>> = { agent: 'Agent', judge: 'Review', approval: 'Approval', tool: 'Tool', merge: 'Merge' }
// What a ticket workflow's stop steps look for, so the step before them reads "Waits for you when it replies Asked:"
const STOP_PATTERN = /^\(\^\|\\n\)/

const lookOf = (agent: HubAgent): BotLook => ({ color: agent.color, mark: agent.mark ?? '' })

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** The subagents the agent's folder and the workflow's projects define, which a step can run as */
function useSubagents(agent: string, projects: string[] = []): Subagent[] {
  const [list, setList] = useState<Subagent[]>([])
  const folders = projects.join('\n')
  useEffect(() => {
    let current = true
    setList([])
    hubApi.subagents(agent, folders ? folders.split('\n') : []).then(
      (found) => current && setList(found),
      () => undefined
    )
    return () => void (current = false)
  }, [agent, folders])
  return list
}

/** A select as a pill, as wide as the picked option, with the app's chevron rather than the system's */
function PillSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="relative inline-flex shrink-0">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 field-sizing-content appearance-none rounded-full bg-foreground/5 pr-6 pl-2.5 text-xs outline-none"
      >
        {children}
      </select>
      <Icon name="chevron" className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 rotate-90 opacity-65" />
    </span>
  )
}

function AgentSelect({ value, onChange }: { value: string; onChange: (agent: string) => void }): React.JSX.Element {
  const agents = hubAgents.useValue()
  return (
    <PillSelect label="Agent" value={value} onChange={onChange}>
      {!isCodingAgent(value) && !agents.some((agent) => agent.id === value) && <option value={value}>Pick an agent</option>}
      <optgroup label="Coding agents">
        {Object.entries(CODING_AGENTS).map(([id, name]) => (
          <option key={id} value={id}>
            on {name}
          </option>
        ))}
      </optgroup>
      {agents.length > 0 && (
        <optgroup label="Bots">
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </optgroup>
      )}
    </PillSelect>
  )
}

/** A subagent by name: each run takes the one its repo defines, so one workflow serves every project */
function SubagentSelect({
  roles,
  value,
  onChange,
  label = 'Run as',
  unset = 'as itself'
}: {
  roles: SubagentRole[]
  value: string | null
  onChange: (name: string | null) => void
  label?: string
  unset?: string
}): React.JSX.Element | null {
  if (!roles.length && !value) return null
  const name = value && roleName(value)
  return (
    <PillSelect label={label} value={name ?? ''} onChange={(picked) => onChange(picked || null)}>
      <option value="">{unset}</option>
      {name && !roles.some((role) => role.name === name) && <option value={name}>as {name} (none found)</option>}
      {roles.map((role) => (
        <option key={role.name} value={role.name} title={role.description}>
          as {role.name}
        </option>
      ))}
    </PillSelect>
  )
}

function BotEditor({ agent, workflows, onSaved }: { agent: HubAgent; workflows: Workflow[]; onSaved: (id: string) => void }): React.JSX.Element {
  const host = useHost()
  const subagents = useSubagents(agent.id)
  const usedIn = workflows.filter((workflow) => workflow.nodes.some((node) => (node.kind === 'agent' || node.kind === 'judge') && node.agent === agent.id))
  return (
    <div className="flex flex-col gap-7">
      <AgentEditor inline key={agent.updatedAt} agent={agent} onClose={() => undefined} onSaved={onSaved} />

      <Section title="Subagents" hint="Found in .claude/agents, .rulesync/subagents and .codex/agents of its folder. A workflow step can run as any of them.">
        {subagents.length ? (
          <div className="flex flex-col overflow-hidden rounded-xl ring-1 ring-border">
            {subagents.map((subagent) => (
              <div key={subagent.path} className="flex items-center gap-3 border-t border-border px-3 py-2 first:border-t-0">
                <Icon name="user" className="size-3.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium">{subagent.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{subagent.path}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{subagent.description}</div>
                </div>
                <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[11px] text-muted-foreground">{subagent.model ?? 'inherits'}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">None in its folder.</p>
        )}
      </Section>

      {usedIn.length > 0 && (
        <Section title="Used in">
          <div className="flex flex-wrap gap-1.5">
            {usedIn.map((workflow) => (
              <span key={workflow.id} className={OUTLINED}>
                <Icon name="layers" className="size-3" />
                {workflow.name}
              </span>
            ))}
          </div>
        </Section>
      )}

      <button onClick={() => deleteAgent(host, agent)} className={`${OUTLINED} self-start text-red-500`}>
        <Icon name="trash" className="size-3" />
        Delete bot
      </button>
    </div>
  )
}

/** The steps from the input on, each step's first way out; a condition goes on by its no side, since its yes side ends the run */
function pathOf(workflow: Workflow): WorkflowNode[] {
  const path: WorkflowNode[] = []
  let node: WorkflowNode | undefined = workflow.nodes.find((candidate) => candidate.kind === 'input')
  while (node && !path.includes(node)) {
    path.push(node)
    const from = node.id
    const next = workflow.edges.find((edge) => edge.from === from && edge.branch !== 'true')?.to
    node = workflow.nodes.find((candidate) => candidate.id === next)
  }
  return path
}

/** The step with the conditions right after it, which stop the run when its reply matches */
type Card = { node: WorkflowNode; stops: Extract<WorkflowNode, { kind: 'condition' }>[] }

const cardsOf = (path: WorkflowNode[]): Card[] =>
  path.reduce<Card[]>((cards, node) => {
    const last = cards.at(-1)
    if (node.kind === 'condition' && last) last.stops.push(node)
    else if (node.kind !== 'input' && node.kind !== 'output') cards.push({ node, stops: [] })
    return cards
  }, [])

/** Drops the step and its stop steps, joining what led into it to what came after */
function withoutStep(workflow: Workflow, card: Card): Workflow {
  const gone = new Set([card.node.id, ...card.stops.map((stop) => stop.id)])
  const path = pathOf(workflow)
  const after = path[path.findIndex((node) => node.id === (card.stops.at(-1) ?? card.node).id) + 1]
  const into = workflow.edges.filter((edge) => edge.to === card.node.id)
  const kept = workflow.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to))
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !gone.has(node.id)),
    edges: after ? [...kept, ...into.map((edge) => ({ ...edge, id: `${edge.from}-${after.id}`, to: after.id }))] : kept
  }
}

/** Adds an agent step before the output, or at the end without one */
function withStep(workflow: Workflow, agent: string): Workflow {
  const path = pathOf(workflow)
  const output = path.find((node) => node.kind === 'output')
  const before = output ? path[path.indexOf(output) - 1] : path.at(-1)
  if (!before) return workflow
  const id = `step-${crypto.randomUUID().slice(0, 8)}`
  const step: AgentNode = { id, kind: 'agent', agent, prompt: '{{prev}}', folder: null, retries: 0, onError: 'stop', timeoutMin: MAX_TIMEOUT_MIN }
  const branch = before.kind === 'condition' ? 'false' : null
  const kept = workflow.edges.filter((edge) => !(output && edge.from === before.id && edge.to === output.id))
  return {
    ...workflow,
    nodes: [...workflow.nodes, step],
    edges: [...kept, { id: `${before.id}-${id}`, from: before.id, to: id, branch }, ...(output ? [{ id: `${id}-${output.id}`, from: id, to: output.id, branch: null }] : [])],
    layout: { ...workflow.layout, [id]: { x: path.length * 260, y: 120 } }
  }
}

function StepCard({
  card,
  index,
  projects,
  onChange,
  onRemove
}: {
  card: Card
  index: number
  projects: string[]
  onChange: (node: WorkflowNode) => void
  onRemove: () => void
}): React.JSX.Element {
  const { node } = card
  const [open, setOpen] = useState(false)
  const roles = subagentRoles(useSubagents(node.kind === 'agent' ? node.agent : '', projects))
  const role = node.kind === 'agent' && node.subagent ? roleName(node.subagent) : null
  const defined = roles.find((candidate) => candidate.name === role)
  return (
    <div className="relative flex gap-3">
      <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-popover text-[11px] font-medium text-muted-foreground ring-1 ring-input">
        {index + 1}
      </span>
      <div className="group flex min-w-0 flex-1 flex-col gap-2 rounded-2xl bg-foreground/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">{STEP_KIND[node.kind] ?? node.kind}</span>
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex min-w-16 flex-1 items-center gap-1 self-stretch font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            <Icon name="chevron" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="truncate">{node.id}</span>
          </button>
          <span className="flex gap-1.5">
            {(node.kind === 'agent' || node.kind === 'judge') && <AgentSelect value={node.agent} onChange={(agent) => onChange({ ...node, agent })} />}
            {node.kind === 'agent' && <SubagentSelect roles={roles} value={node.subagent ?? null} onChange={(subagent) => onChange({ ...node, subagent })} />}
          </span>
          <button
            onClick={onRemove}
            aria-label="Remove step"
            className="grid size-6 place-items-center rounded-full text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent"
          >
            <Icon name="trash" className="size-3" />
          </button>
        </div>
        {open && (
          <>
            {node.kind === 'agent' && (
              <span className={`text-xs ${role && !defined ? 'text-amber-500' : 'text-muted-foreground'}`}>
                {!role
                  ? roles.length
                    ? 'Runs as the agent itself. Pick a subagent to run as the one each repo defines by that name; a repo without one runs it as the agent itself.'
                    : 'Repos can define subagents in .claude/agents, .rulesync/subagents or .codex/agents; a step can then run as one.'
                  : defined
                    ? `Runs as the ${role} its repo defines: ${defined.projects.join(', ')}. In other repos, as itself.`
                    : `No repo here defines ${role}. Add .claude/agents/${role}.md to the repos that should have one.`}
              </span>
            )}
            {node.kind === 'agent' && (
              <textarea
                aria-label="Prompt"
                value={node.prompt}
                onChange={(event) => onChange({ ...node, prompt: event.target.value })}
                rows={2}
                className="field-sizing-content max-h-60 resize-none bg-transparent font-mono text-xs leading-relaxed text-muted-foreground outline-none focus:text-foreground"
              />
            )}
            {node.kind === 'judge' && (
              <span className="text-xs text-muted-foreground">
                Scores it on "{node.rubric}". Below {node.minScore}/10 it goes back to {node.retryStep ?? 'nobody'} with the issues, up to {node.rounds} rounds.
              </span>
            )}
            {node.kind === 'approval' && <span className="text-xs text-muted-foreground">Asks you: {node.message}</span>}
            {node.kind === 'tool' && <span className="font-mono text-xs text-muted-foreground">{node.tool}</span>}
          </>
        )}
        {card.stops.map((stop) => (
          <span key={stop.id} className="flex items-center gap-1.5 text-xs text-amber-500">
            <Icon name="alert" className="size-3" />
            {stop.test === 'regex' && STOP_PATTERN.test(stop.value) ? (
              <>
                Waits for you when it replies <code className="font-mono">{stop.value.replace(STOP_PATTERN, '')}</code>
              </>
            ) : (
              <>Ends the run when it {stop.test === 'empty' ? 'is empty' : `${stop.test === 'regex' ? 'matches' : stop.test} ${stop.value}`}</>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function WatchRow({ watch, onChange, onRemove }: { watch: Watch; onChange: (watch: Watch) => void; onRemove: () => void }): React.JSX.Element {
  return (
    <div className={CARD}>
      <Icon name={WATCHES[watch.source].icon} className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-[13px]">{WATCHES[watch.source].label}</div>
        {watch.source === 'notion' && (
          <input
            aria-label="Notion data source"
            value={watch.dataSource ?? ''}
            onChange={(event) => onChange({ ...watch, dataSource: event.target.value })}
            placeholder="Data source id or link"
            className="w-full bg-transparent font-mono text-xs text-muted-foreground outline-none focus:text-foreground"
          />
        )}
        <input
          aria-label={watch.source === 'jira' ? 'JQL' : 'Where'}
          value={watch.query}
          onChange={(event) => onChange({ ...watch, query: event.target.value })}
          className="w-full bg-transparent font-mono text-xs text-muted-foreground outline-none focus:text-foreground"
        />
      </div>
      <Switch checked={watch.enabled} onChange={() => onChange({ ...watch, enabled: !watch.enabled })} label="Watch on" />
      <button onClick={onRemove} aria-label="Remove trigger" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent">
        <Icon name="close" className="size-3" />
      </button>
    </div>
  )
}

function ProjectRow({ rule, steps, onChange, onRemove }: { rule: ProjectRule; steps: string[]; onChange: (rule: ProjectRule) => void; onRemove: () => void }): React.JSX.Element {
  const roles = subagentRoles(useSubagents('', rule.folder ? [rule.folder] : []))
  const picks = rule.subagents ?? {}
  const pick = (step: string, name: string | null): void =>
    onChange({ ...rule, subagents: { ...Object.fromEntries(Object.entries(picks).filter(([key]) => key !== step)), ...(name && { [step]: name }) } })
  return (
    <div className="flex flex-col gap-1.5">
      <div className={CARD}>
        <input
          aria-label="Jira project or label"
          value={rule.match}
          onChange={(event) => onChange({ ...rule, match: event.target.value })}
          placeholder="BF or a label"
          spellCheck={false}
          className="w-28 shrink-0 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60"
        />
        <div className="min-w-0 flex-1">
          <FolderField
            value={rule.folder}
            onChange={(folder) => onChange({ ...rule, folder })}
            placeholder="The repo it runs in"
            className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground group-hover:text-foreground"
          />
        </div>
        <button onClick={onRemove} aria-label="Remove project" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent">
          <Icon name="close" className="size-3" />
        </button>
      </div>
      {(roles.length > 0 || Object.keys(picks).length > 0) && (
        <div className="grid w-fit grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 pl-3 text-xs text-muted-foreground">
          {steps.map((step) => (
            <Fragment key={step}>
              {step}
              <SubagentSelect roles={roles} value={picks[step] ?? null} onChange={(name) => pick(step, name)} label={`${step} runs as`} unset="as the step says" />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/** Slack messages as the trigger, in batches; with several such workflows the shortest interval wins */
function SlackRow({ trigger, onChange, onRemove }: { trigger: SlackTrigger; onChange: (trigger: SlackTrigger) => void; onRemove: () => void }): React.JSX.Element {
  const host = useHost()
  return (
    <div className={CARD}>
      <BrandMark brand="slack" className="size-4 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-[13px]">Slack messages</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            Every
            <WholeNumber
              min={1}
              max={MAX_SLACK_INTERVAL_MIN}
              value={trigger.intervalMin}
              onChange={(intervalMin) => onChange({ ...trigger, intervalMin })}
              className="h-6 w-12 rounded-md bg-foreground/5 px-1.5 text-center text-foreground outline-none"
            />
            min
          </label>
          <span className="flex items-center gap-1.5">
            Include mine
            <Switch checked={trigger.includeOwn} onChange={() => onChange({ ...trigger, includeOwn: !trigger.includeOwn })} label="Include my own messages" />
          </span>
          <button onClick={() => host.openSettings('plugin:slack')} className="underline hover:text-foreground">
            Slack tokens
          </button>
        </div>
      </div>
      <button onClick={onRemove} aria-label="Remove trigger" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent">
        <Icon name="close" className="size-3" />
      </button>
    </div>
  )
}

function ScheduleRow({ schedule, onChange, onRemove }: { schedule: Schedule; onChange: (schedule: Schedule) => void; onRemove: () => void }): React.JSX.Element {
  return (
    <div className={CARD}>
      <Icon name="history" className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2 text-[13px]">
          On a schedule
          {!isCron(schedule.cron) && <span className="text-xs text-red-500">Not a crontab line</span>}
        </div>
        <input
          aria-label="Cron"
          value={schedule.cron}
          onChange={(event) => onChange({ ...schedule, cron: event.target.value })}
          className="w-full bg-transparent font-mono text-xs text-muted-foreground outline-none focus:text-foreground"
        />
        <input
          aria-label="Input"
          value={schedule.prompt}
          onChange={(event) => onChange({ ...schedule, prompt: event.target.value })}
          placeholder="What the run gets as its input"
          className="w-full bg-transparent text-xs text-muted-foreground outline-none focus:text-foreground"
        />
      </div>
      <Switch checked={schedule.enabled} onChange={() => onChange({ ...schedule, enabled: !schedule.enabled })} label="Schedule on" />
      <button onClick={onRemove} aria-label="Remove trigger" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent">
        <Icon name="close" className="size-3" />
      </button>
    </div>
  )
}

function WorkflowEditor({ workflow, agents }: { workflow: Workflow; agents: HubAgent[] }): React.JSX.Element {
  const [draft, setDraft] = useState(workflow)
  const [problem, setProblem] = useState('')
  const dirty = draft !== workflow
  const path = pathOf(draft)
  const cards = cardsOf(path)
  const input = draft.nodes.find((node) => node.kind === 'input')
  const watches = input?.watches ?? []
  const schedules = input?.schedules ?? []
  const projects = (input?.kind === 'input' && input.projects) || []
  const events = (input?.kind === 'input' && input.events) || []
  const slack = events.includes(SLACK_EVENT) && input?.kind === 'input' ? (input.slack ?? SLACK_TRIGGER) : null
  const problems = validate(
    draft,
    agents.map((agent) => agent.id)
  )
  const canSave = dirty && !problems.length && schedules.every((schedule) => isCron(schedule.cron))
  const fixer = agents.find((agent) => agent.id === draft.nodes.find((node): node is AgentNode => node.kind === 'agent')?.agent)

  const setNode = (next: WorkflowNode): void => setDraft({ ...draft, nodes: draft.nodes.map((node) => (node.id === next.id ? next : node)) })
  const setInput = (changes: { watches?: Watch[]; schedules?: Schedule[]; atOnce?: number; projects?: ProjectRule[]; events?: string[]; slack?: SlackTrigger }): void =>
    void (input && setNode({ ...input, ...changes }))
  const addSlack = (): void => {
    setPluginEnabled('slack', true)
    setInput({ events: [...events, SLACK_EVENT], slack: SLACK_TRIGGER })
  }
  const addWatch = (source: Watch['source']): void =>
    setInput({ watches: [...watches, { id: crypto.randomUUID(), source, query: WATCH_QUERY[source], ...(source === 'notion' && { dataSource: '' }), enabled: false }] })
  const addSchedule = (): void => setInput({ schedules: [...schedules, { id: crypto.randomUUID(), cron: '0 9 * * 1-5', prompt: '', notify: false, enabled: false }] })
  const run = (task: Promise<unknown>): void =>
    void task.then(
      () => setProblem(''),
      (reason: unknown) => setProblem(errorMessage(reason))
    )
  const remove = (): void => void (window.confirm(`Delete ${workflow.name}?`) && run(hubApi.removeWorkflow(workflow.id)))

  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-center gap-2">
        <input
          aria-label="Workflow name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          className="min-w-0 flex-1 bg-transparent text-xl font-medium outline-none"
        />
        {!watches.length && (
          <button disabled={dirty} onClick={() => run(hubApi.runWorkflow(workflow.id, ''))} className={OUTLINED}>
            <Icon name="play" className="size-3" />
            Run now
          </button>
        )}
        {dirty && (
          <button onClick={() => setDraft(workflow)} className={OUTLINED}>
            Discard
          </button>
        )}
        <button disabled={!canSave} onClick={() => run(hubApi.saveWorkflow({ ...draft, name: draft.name.trim() || workflow.name, updatedAt: Date.now() }))} className={FILLED}>
          Save
        </button>
        <button onClick={remove} aria-label="Delete" className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent">
          <Icon name="trash" className="size-3.5" />
        </button>
      </div>
      {(problem || problems.length > 0) && (
        <div className="flex flex-col gap-0.5 text-xs text-red-500">
          {problem && <span>{problem}</span>}
          {problems.map((issue) => (
            <span key={`${issue.node}:${issue.message}`}>
              {issue.node && <code className="mr-1 font-mono">{issue.node}</code>}
              {issue.message}
            </span>
          ))}
        </div>
      )}

      <Section title="When" hint="Watches start one run per ticket that starts matching, checked every few minutes while Treeix runs">
        {watches.map((watch) => (
          <WatchRow
            key={watch.id}
            watch={watch}
            onChange={(next) => setInput({ watches: watches.map((candidate) => (candidate.id === next.id ? next : candidate)) })}
            onRemove={() => setInput({ watches: watches.filter((candidate) => candidate.id !== watch.id) })}
          />
        ))}
        {watches.length > 0 && input?.kind === 'input' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            Tickets worked on at a time; the rest wait their turn
            <WholeNumber
              min={1}
              max={MAX_AT_ONCE}
              value={input.atOnce ?? WATCH_AT_ONCE}
              onChange={(atOnce) => setInput({ atOnce })}
              className="h-7 w-14 rounded-lg bg-foreground/5 px-2 text-center text-[13px] text-foreground ring-1 ring-transparent outline-none focus:ring-input"
            />
          </label>
        )}
        {schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            onChange={(next) => setInput({ schedules: schedules.map((candidate) => (candidate.id === next.id ? next : candidate)) })}
            onRemove={() => setInput({ schedules: schedules.filter((candidate) => candidate.id !== schedule.id) })}
          />
        ))}
        {slack && <SlackRow trigger={slack} onChange={(next) => setInput({ slack: next })} onRemove={() => setInput({ events: events.filter((name) => name !== SLACK_EVENT) })} />}
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => addWatch('jira')} className={OUTLINED}>
            <Icon name="ticket" className="size-3" />
            Watch Jira
          </button>
          <button onClick={() => addWatch('notion')} className={OUTLINED}>
            <Icon name="bookOpen" className="size-3" />
            Watch Notion
          </button>
          {!slack && (
            <button onClick={addSlack} className={OUTLINED}>
              <BrandMark brand="slack" className="size-3" />
              Slack messages
            </button>
          )}
          <button onClick={addSchedule} className={OUTLINED}>
            <Icon name="history" className="size-3" />
            Schedule
          </button>
        </div>
      </Section>

      {watches.length > 0 && (
        <Section
          title="Where"
          hint="A ticket runs in its own worktree of the first project its Jira key or one of its labels names, else of a project next to these named like them (a Notion task tagged Betfeel finds a betfeel folder), on a branch named for the ticket, and loads that repo's subagents. Under a project, pick which of its subagents each step runs as. The rest run in each step's agent folder."
        >
          {projects.map((rule, index) => (
            <ProjectRow
              key={index}
              rule={rule}
              steps={draft.nodes.flatMap((node) => (node.kind === 'agent' ? [node.id] : []))}
              onChange={(next) => setInput({ projects: projects.map((candidate, at) => (at === index ? next : candidate)) })}
              onRemove={() => setInput({ projects: projects.filter((_, at) => at !== index) })}
            />
          ))}
          <div>
            <button onClick={() => setInput({ projects: [...projects, { match: '', folder: '' }] })} className={OUTLINED}>
              <Icon name="folder" className="size-3" />
              Add project
            </button>
          </div>
        </Section>
      )}

      <Section
        title="Then"
        hint="Each step starts a fresh session in its agent's folder, with what the step before it replied. A step can run as a subagent its projects define: the Where repos, the repos under them and the folders their Claude settings add. A project without it runs the step as the agent itself."
      >
        <div className="relative flex flex-col gap-2.5 before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border">
          {cards.map((card, index) => (
            <StepCard
              key={card.node.id}
              card={card}
              index={index}
              projects={projects.map((rule) => rule.folder).filter(Boolean)}
              onChange={setNode}
              onRemove={() => setDraft(withoutStep(draft, card))}
            />
          ))}
        </div>
        {draft.nodes.length > path.length && (
          <p className="ml-9 text-xs text-muted-foreground">{draft.nodes.length - path.length} more steps branch off this path; the canvas on the Agents page shows them.</p>
        )}
        <button disabled={!agents.length} onClick={() => agents[0] && setDraft(withStep(draft, agents[0].id))} className={`${OUTLINED} ml-9 self-start`}>
          <Icon name="plus" className="size-3" />
          Add step
        </button>
      </Section>

      {watches.length > 0 && (
        <Section title="Until it's merged" hint="Once a run opens a pull request, Treeix checks it every few minutes while it runs. Comments alone start nothing.">
          <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Icon name="pullRequest" className="size-3.5" />
              CI fails: up to 3 fixes in a row, then it waits for you
            </span>
            <span className="flex items-center gap-2">
              <Icon name="comment" className="size-3.5" />
              A reviewer requests changes: one fix with every open comment, replies start with Agent:
            </span>
            <span className="flex items-center gap-2">
              <Icon name="check" className="size-3.5" />
              Merged: the ticket moves to Done
            </span>
            {fixer && (
              <span className="flex items-center gap-1.5">
                Fixed by
                <BotAvatar look={lookOf(fixer)} className="size-4" />
                <span>
                  <span className="text-foreground">{fixer.name}</span>, the first agent step's agent
                </span>
              </span>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

function NavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] ${active ? 'bg-foreground/8 font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function NavGroup({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center justify-between pr-1 pl-2 text-[11px] font-medium text-muted-foreground/80">
        {title}
        {onAdd && (
          <button
            onClick={onAdd}
            aria-label={`New ${title.toLowerCase().replace(/s$/, '')}`}
            className="grid size-5 place-items-center rounded-md hover:bg-accent hover:text-foreground"
          >
            <Icon name="plus" className="size-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

type Selection = { kind: 'page'; page: BotsSettingsPage } | { kind: 'plugin'; id: string } | { kind: 'bot'; id: string | null } | { kind: 'workflow'; id: string | null }

/** Where a request for a page of the old Settings lands: a plugin's own page, or the first page */
function selectionOf(page: PageId | null): Selection {
  const plugin = page && pluginOf(page)
  const fixed = plugin && botsPageOf(plugin)
  return fixed ? { kind: 'page', page: fixed } : plugin ? { kind: 'plugin', id: plugin } : { kind: 'page', page: 'appearance' }
}

/** Settings for the Bots window in one vertical list: the app's own pages, then each bot and workflow to set up */
export function Configure(): React.JSX.Element {
  const chromeless = useChromeless()
  const agents = hubAgents.useValue()
  const workflows = hubWorkflows.useValue()
  const [selected, setSelected] = useState<Selection>(() => selectionOf(takeRequestedPage()))
  useEffect(() => onSettingsPage((page) => setSelected(selectionOf(page))), [])
  // Plugins whose settings no fixed page shows; AI Hub is this window
  const { loaded } = usePlugins()
  const pages = shownBotsPages(loaded)
  const pluginPages = loaded.filter(({ manifest, plugin }) => plugin.Settings && manifest.id !== 'hub' && !botsPageOf(manifest.id))
  const [problem, setProblem] = useState('')
  const agent = (selected.kind === 'bot' && agents.find((candidate) => candidate.id === selected.id)) || agents[0]
  const workflow = (selected.kind === 'workflow' && workflows.find((candidate) => candidate.id === selected.id)) || workflows[0]
  const newBot = (): void => setSelected({ kind: 'bot', id: null })
  const newWorkflow = (): void => {
    // Without bots, steps run on Claude as it is
    const made = ticketWorkflow('jira', agents[0]?.id ?? 'claude', false)
    const names = new Set(workflows.map((candidate) => candidate.name))
    let name = made.name
    for (let count = 2; names.has(name); count++) name = `${made.name} ${count}`
    hubApi.saveWorkflow({ ...made, name }).then(
      () => (setSelected({ kind: 'workflow', id: made.id }), setProblem('')),
      (reason: unknown) => setProblem(errorMessage(reason))
    )
  }
  return (
    <>
      <header className={`flex h-11 shrink-0 items-center gap-3 border-b border-border px-4 ${chromeless ? '' : '[-webkit-app-region:drag]'}`}>
        <span className="text-[13px] font-medium">Settings</span>
        <span className="flex-1 truncate text-right text-xs text-red-500">{problem}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[180px] shrink-0 flex-col lg:w-[220px] gap-4 overflow-y-auto border-r border-border p-2">
          {[...new Set(pages.map(([, spec]) => spec.group))].map((group) => (
            <NavGroup key={group} title={group}>
              {pages
                .filter(([, spec]) => spec.group === group)
                .map(([page, { label, icon, brand }]) => (
                  <NavItem
                    key={page}
                    active={selected.kind === 'page' && selected.page === page}
                    onClick={() => setSelected({ kind: 'page', page })}
                    icon={brand ? <BrandMark brand={brand} /> : <Icon name={icon} className="size-3.5" />}
                    label={label}
                  />
                ))}
            </NavGroup>
          ))}
          {pluginPages.length > 0 && (
            <NavGroup title="Other plugins">
              {pluginPages.map(({ manifest, plugin }) => (
                <NavItem
                  key={manifest.id}
                  active={selected.kind === 'plugin' && selected.id === manifest.id}
                  onClick={() => setSelected({ kind: 'plugin', id: manifest.id })}
                  icon={<Icon name={plugin.tabs?.[0]?.icon ?? 'plug'} className="size-3.5" />}
                  label={manifest.name}
                />
              ))}
            </NavGroup>
          )}
          <NavGroup title="Bots" onAdd={newBot}>
            {agents.map((candidate) => (
              <NavItem
                key={candidate.id}
                active={selected.kind === 'bot' && selected.id !== null && candidate.id === agent?.id}
                onClick={() => setSelected({ kind: 'bot', id: candidate.id })}
                icon={<BotAvatar look={lookOf(candidate)} className="size-5" />}
                label={candidate.name}
              />
            ))}
          </NavGroup>
          <NavGroup title="Workflows" onAdd={newWorkflow}>
            {workflows.map((candidate) => (
              <NavItem
                key={candidate.id}
                active={selected.kind === 'workflow' && candidate.id === workflow?.id}
                onClick={() => setSelected({ kind: 'workflow', id: candidate.id })}
                icon={<Icon name="layers" className="size-3.5" />}
                label={candidate.name}
              />
            ))}
          </NavGroup>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-5 py-6 select-text lg:px-8 lg:py-7">
            {selected.kind === 'page' ? (
              <BotsWindowSettings page={selected.page} />
            ) : selected.kind === 'plugin' ? (
              <PluginPage key={selected.id} id={selected.id} />
            ) : selected.kind === 'bot' && agent && selected.id !== null ? (
              <BotEditor key={agent.id} agent={agent} workflows={workflows} onSaved={(id) => setSelected({ kind: 'bot', id })} />
            ) : selected.kind === 'bot' ? (
              <AgentEditor key="new" inline agent={null} onClose={() => undefined} onSaved={(id) => setSelected({ kind: 'bot', id })} />
            ) : (
              <>
                {workflow ? (
                  <WorkflowEditor key={`${workflow.id}:${workflow.updatedAt}`} workflow={workflow} agents={agents} />
                ) : (
                  <p className="text-[13px] text-muted-foreground">No workflows yet. The plus beside Workflows starts one that takes Jira tickets to a merged pull request.</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
