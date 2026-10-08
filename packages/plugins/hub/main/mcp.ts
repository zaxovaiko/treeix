import { randomUUID } from 'node:crypto'
import type { McpTool } from '@treeix/sdk/main'
import { isJson, isString } from '@treeix/shared/json'
import { isCron } from '../shared/cron'
import { type HubAgent, isHubAgent, isTimeout, MAX_TIMEOUT_MIN, type Schedule } from '../shared/types'
import { validate } from '../shared/validate'
import { ASK_TIMEOUT_MIN, type Edge, type Run, type Workflow, type WorkflowNode } from '../shared/workflow'
import type { createEngine } from './engine'

type Args = Record<string, unknown>

/** The first color the agent editor offers */
const DEFAULT_COLOR = '#4f5ff0'
const TESTS = ['contains', 'equals', 'regex', 'empty'] as const

const required = (args: Args, name: string): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

/** A string argument, undefined when left out */
const optional = (args: Args, name: string): string | undefined => {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

/** An argument whose empty string or null means "the default" */
const nullable = (args: Args, name: string, current: string | null): string | null => (args[name] === null ? null : (optional(args, name) ?? current ?? '').trim() || null)

const named = <T extends { id: string; name: string }>(items: T[], name: string): T | undefined => {
  const key = name.trim().toLowerCase()
  return items.find((item) => item.name.toLowerCase() === key || item.id === name.trim())
}

/** Another item already uses the name, which would make lookups by name ambiguous */
const assertFree = (items: { id: string; name: string }[], name: string, id: string): void => {
  if (items.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is taken`)
}

export const findAgent = (agents: HubAgent[], name: string): HubAgent => {
  const agent = named(agents, name)
  if (!agent) throw new Error(`No agent named ${name}; hub_agents lists them`)
  return agent
}

const findWorkflow = (workflows: Workflow[], name: string): Workflow => {
  const workflow = named(workflows, name)
  if (!workflow) throw new Error(`No workflow named ${name}; hub_workflows lists them`)
  return workflow
}

function toSchedule(value: unknown): Schedule {
  if (!isJson(value) || !isString(value.cron) || !isString(value.prompt)) throw new Error('A schedule needs cron and prompt')
  if (!isCron(value.cron)) throw new Error(`${value.cron} is not a crontab line`)
  const { command, timeoutMin } = value
  if (command !== undefined && !isString(command)) throw new Error('command must be a string')
  if (timeoutMin !== undefined && !isTimeout(timeoutMin)) throw new Error(`timeoutMin must be a whole number of minutes, 1 to ${MAX_TIMEOUT_MIN}`)
  return {
    id: randomUUID(),
    cron: value.cron,
    prompt: value.prompt,
    notify: value.notify !== false,
    enabled: value.enabled !== false,
    ...(command?.trim() ? { command: command.trim() } : {}),
    ...(timeoutMin === undefined ? {} : { timeoutMin })
  }
}

/** The agent named `name` with the given fields changed, or a new one when none has that name */
export function toAgent(args: Args, agents: HubAgent[], now: number): HubAgent {
  const existing = named(agents, required(args, 'name'))
  const name = (optional(args, 'rename') ?? existing?.name ?? required(args, 'name')).trim()
  const id = existing?.id ?? randomUUID()
  assertFree(agents, name, id)
  const runtime = optional(args, 'runtime')?.trim()
  const schedules = args.schedules
  if (schedules !== undefined && !Array.isArray(schedules)) throw new Error('schedules must be a list')
  const icon = optional(args, 'icon')?.trim()
  const autoApprove = args.autoApprove
  const agent: HubAgent = {
    id,
    name,
    icon: icon || existing?.icon || name.slice(0, 1).toUpperCase(),
    avatar: existing?.avatar ?? null,
    color: optional(args, 'color')?.trim() || existing?.color || DEFAULT_COLOR,
    runtime: runtime
      ? /^https?:\/\//.test(runtime)
        ? { kind: 'api', baseUrl: runtime }
        : { kind: 'agent', agent: runtime }
      : (existing?.runtime ?? { kind: 'agent', agent: 'claude' }),
    model: nullable(args, 'model', existing?.model ?? null),
    mode: nullable(args, 'mode', existing?.mode ?? null),
    instructions: optional(args, 'instructions') ?? existing?.instructions ?? '',
    folder: nullable(args, 'folder', existing?.folder ?? null),
    autoApprove: typeof autoApprove === 'boolean' ? autoApprove : (existing?.autoApprove ?? false),
    schedules: schedules ? schedules.map(toSchedule) : (existing?.schedules ?? []),
    updatedAt: now
  }
  if (!isHubAgent(agent)) throw new Error('Invalid agent')
  return agent
}

function toNode(value: unknown, agents: HubAgent[]): WorkflowNode {
  if (!isJson(value) || !isString(value.id) || !value.id.trim()) throw new Error('Every step needs an id')
  const id = value.id.trim()
  const field = (name: string, fallback: string): string => optional(value, name) ?? fallback
  switch (value.kind) {
    case 'input':
      return { id, kind: 'input' }
    case 'agent':
      return {
        id,
        kind: 'agent',
        agent: findAgent(agents, required(value, 'agent')).id,
        prompt: field('prompt', '{{prev}}'),
        folder: nullable(value, 'folder', null),
        retries: typeof value.retries === 'number' ? value.retries : 0,
        onError: value.onError === 'continue' ? 'continue' : 'stop',
        timeoutMin: typeof value.timeoutMin === 'number' ? value.timeoutMin : ASK_TIMEOUT_MIN
      }
    case 'merge':
    case 'output':
      return { id, kind: value.kind, template: field('template', '{{prev}}') }
    case 'condition': {
      const test = TESTS.find((entry) => entry === value.test)
      if (!test) throw new Error(`Step ${id} needs test: ${TESTS.join(', ')}`)
      return { id, kind: 'condition', source: field('source', '{{prev}}'), test, value: field('value', '') }
    }
    case 'approval':
      return { id, kind: 'approval', message: field('message', '{{prev}}') }
  }
  throw new Error(`Step ${id} has an unknown kind`)
}

function toEdge(value: unknown, steps: Set<string>): Edge {
  if (!isJson(value) || !isString(value.from) || !isString(value.to)) throw new Error('Every edge needs from and to')
  for (const end of [value.from, value.to]) if (!steps.has(end)) throw new Error(`An edge goes to ${end}, which is not a step`)
  const branch = value.branch === 'true' || value.branch === true ? 'true' : value.branch === 'false' || value.branch === false ? 'false' : null
  return { id: `${value.from}-${value.to}${branch ? `-${branch}` : ''}`, from: value.from, to: value.to, branch }
}

/** The workflow named `name` with its steps replaced, or a new one; throws what keeps it from running */
export function toWorkflow(args: Args, workflows: Workflow[], agents: HubAgent[], now: number): Workflow {
  const existing = named(workflows, required(args, 'name'))
  const name = (optional(args, 'rename') ?? existing?.name ?? required(args, 'name')).trim()
  const id = existing?.id ?? randomUUID()
  assertFree(workflows, name, id)
  if (!Array.isArray(args.nodes) || !Array.isArray(args.edges)) throw new Error('nodes and edges are required lists')
  const nodes = args.nodes.map((node) => toNode(node, agents))
  const steps = new Set(nodes.map((node) => node.id))
  if (steps.size !== nodes.length) throw new Error('Step ids must be unique')
  const edges = args.edges.map((edge) => toEdge(edge, steps))
  // Steps without a saved position fall in a row on the canvas
  const layout = Object.fromEntries(Object.entries(existing?.layout ?? {}).filter(([step]) => steps.has(step)))
  const workflow: Workflow = { id, name, nodes, edges, layout, updatedAt: now }
  const problems = validate(
    workflow,
    agents.map((agent) => agent.id)
  )
  if (problems.length) throw new Error(problems.map((problem) => (problem.node ? `${problem.node}: ${problem.message}` : problem.message)).join('\n'))
  return workflow
}

const upsert = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((entry) => entry.id === item.id) ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]

/** A JSON.stringify replacer that leaves out keys agents have no use for */
const omit =
  (...keys: string[]) =>
  (key: string, value: unknown): unknown =>
    keys.includes(key) ? undefined : value

const failure = (run: Run | null): string => Object.values(run?.nodes ?? {}).find((node) => node.error)?.error ?? `The run ended ${run?.status ?? 'unexpectedly'}`

/** Lets agent sessions read, edit and run the user's hub agents and workflows */
export function hubTools(deps: {
  agents: () => Promise<HubAgent[]>
  saveAgents: (next: HubAgent[]) => Promise<void>
  workflows: () => Promise<Workflow[]>
  saveWorkflows: (next: Workflow[]) => Promise<void>
  engine: ReturnType<typeof createEngine>
}): McpTool[] {
  const { engine } = deps
  const none = { type: 'object', properties: {}, additionalProperties: false }
  const byName = (description: string): Args => ({ type: 'object', properties: { name: { type: 'string', description } }, required: ['name'], additionalProperties: false })

  return [
    {
      name: 'hub_agents',
      description: "Lists the user's AI Hub agents as JSON: name, runtime, model, instructions, folder and schedules. hub_ask asks them, hub_save_agent edits them.",
      inputSchema: none,
      run: async () => {
        const agents = await deps.agents()
        return agents.length ? JSON.stringify(agents, omit('avatar', 'updatedAt'), 2) : 'No agents yet; hub_save_agent creates one'
      }
    },
    {
      name: 'hub_save_agent',
      description:
        'Creates an AI Hub agent, or edits the one with this name. On edit only the fields passed change; schedules, when passed, replace the list. The user sees it in the AI Hub tab right away.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The agent to create or edit' },
          rename: { type: 'string', description: 'A new name for it' },
          instructions: { type: 'string', description: 'Its system prompt' },
          runtime: { type: 'string', description: "What it runs on: an agent id like 'claude' or 'codex', or an OpenAI-compatible base URL. 'claude' by default" },
          model: { type: ['string', 'null'], description: "A model the runtime offers, e.g. 'opus'; null for the runtime's default" },
          mode: { type: ['string', 'null'], description: "A mode the runtime offers; null for the runtime's default" },
          folder: { type: ['string', 'null'], description: 'Absolute path it works in; null for the selected worktree' },
          icon: { type: 'string', description: 'One glyph; its first letter by default' },
          color: { type: 'string', description: 'A CSS color' },
          autoApprove: { type: 'boolean', description: 'Allows every permission it asks for in runs' },
          schedules: {
            type: 'array',
            description: 'Prompts it gets on a crontab schedule while Treeix runs',
            items: {
              type: 'object',
              properties: {
                cron: { type: 'string', description: "Five-field crontab line in local time, e.g. '0 8 * * *'" },
                prompt: { type: 'string', description: 'With a command, {{input}} is the line that started the run' },
                command: {
                  type: 'string',
                  description:
                    "A shell command run at each firing, in the agent's folder, instead of one prompt: every line it prints, `<input>` or `<input>\\t<title>`, starts its own run"
                },
                timeoutMin: { type: 'number', description: 'Minutes each run may take, 10 by default' },
                notify: { type: 'boolean', description: 'Shows the answer as a notification; true by default' },
                enabled: { type: 'boolean', description: 'True by default' }
              },
              required: ['cron', 'prompt'],
              additionalProperties: false
            }
          }
        },
        required: ['name'],
        additionalProperties: false
      },
      run: async (args) => {
        const agents = await deps.agents()
        const agent = toAgent(args, agents, Date.now())
        await deps.saveAgents(upsert(agents, agent))
        return `Saved ${agent.name}`
      }
    },
    {
      name: 'hub_delete_agent',
      description: 'Deletes an AI Hub agent. Workflow steps that ask it stop running until they pick another.',
      inputSchema: byName('The agent'),
      run: async (args) => {
        const agents = await deps.agents()
        const agent = findAgent(agents, required(args, 'name'))
        await deps.saveAgents(agents.filter((entry) => entry.id !== agent.id))
        return `Deleted ${agent.name}`
      }
    },
    {
      name: 'hub_ask',
      description:
        'Asks one of the AI Hub agents (see hub_agents) and waits for its answer, up to 10 minutes. Each ask is a fresh conversation, so include everything the agent needs to know. The user sees the run in the AI Hub tab.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent name' },
          message: { type: 'string' },
          folder: { type: 'string', description: 'Absolute path the agent works in; its own folder by default' }
        },
        required: ['agent', 'message'],
        additionalProperties: false
      },
      run: async (args) => {
        const agent = findAgent(await deps.agents(), required(args, 'agent'))
        const run = await engine.wait(engine.ask(agent.id, required(args, 'message'), typeof args.folder === 'string' && args.folder ? args.folder : null, true).id)
        if (run?.status !== 'done') throw new Error(failure(run))
        return run.output || '(no answer)'
      }
    },
    {
      name: 'hub_workflows',
      description: "Lists the user's AI Hub workflows as JSON: name, steps and edges, in the shape hub_save_workflow takes.",
      inputSchema: none,
      run: async () => {
        const workflows = await deps.workflows()
        return workflows.length ? JSON.stringify(workflows, omit('layout', 'updatedAt'), 2) : 'No workflows yet; hub_save_workflow creates one'
      }
    },
    {
      name: 'hub_save_workflow',
      description: [
        'Creates an AI Hub workflow, or replaces the steps of the one with this name. It is saved only when it can run, else the call fails with what to fix.',
        'Steps by kind:',
        '- input: where the run input enters; exactly one.',
        '- agent: {agent: name, prompt, folder?, retries?: 0, onError?: "stop"|"continue", timeoutMin?: 10}; one fresh session per run, its reply is the output.',
        '- merge | output: {template}; at least one output, whose text is the run result.',
        '- condition: {source, test: "contains"|"equals"|"regex"|"empty", value}; edges leaving it set branch "true" or "false".',
        '- approval: {message}; waits for the user to approve in the AI Hub, then passes its input on.',
        'Templates and prompts read {{input}}, {{prev}} (what flows in) and {{nodes.<id>.output}} of an earlier step.'
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The workflow to create or replace' },
          rename: { type: 'string', description: 'A new name for it' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['input', 'agent', 'merge', 'condition', 'approval', 'output'] } },
              required: ['id', 'kind']
            }
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' }, branch: { type: 'string', enum: ['true', 'false'] } },
              required: ['from', 'to'],
              additionalProperties: false
            }
          }
        },
        required: ['name', 'nodes', 'edges'],
        additionalProperties: false
      },
      run: async (args) => {
        const workflows = await deps.workflows()
        const workflow = toWorkflow(args, workflows, await deps.agents(), Date.now())
        await deps.saveWorkflows(upsert(workflows, workflow))
        return `Saved ${workflow.name}`
      }
    },
    {
      name: 'hub_delete_workflow',
      description: 'Deletes an AI Hub workflow.',
      inputSchema: byName('The workflow'),
      run: async (args) => {
        const workflows = await deps.workflows()
        const workflow = findWorkflow(workflows, required(args, 'name'))
        await deps.saveWorkflows(workflows.filter((entry) => entry.id !== workflow.id))
        return `Deleted ${workflow.name}`
      }
    },
    {
      name: 'hub_run_workflow',
      description: 'Runs an AI Hub workflow and waits for its result. Approval steps wait for the user in the AI Hub tab, so the call can take as long as they do.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The workflow' }, input: { type: 'string', description: 'What {{input}} reads' } },
        required: ['name'],
        additionalProperties: false
      },
      run: async (args) => {
        const workflow = findWorkflow(await deps.workflows(), required(args, 'name'))
        const problem = validate(
          workflow,
          (await deps.agents()).map((agent) => agent.id)
        )[0]
        if (problem) throw new Error(problem.message)
        const run = await engine.wait(engine.launch('workflow', workflow.name, workflow, optional(args, 'input') ?? '', true).id)
        if (run?.status !== 'done') throw new Error(failure(run))
        return run.output || '(no output)'
      }
    }
  ]
}
