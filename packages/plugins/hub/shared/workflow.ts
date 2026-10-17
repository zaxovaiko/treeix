import type { ChatEvent, ChatSpec } from '@treeix/sdk/main'
import { isJson, isString } from '@treeix/shared/json'
import { isSchedule, type Schedule } from './types'

/** An agent node's run: one fresh session, one prompt, the reply as its output */
export type AgentNode = {
  id: string
  kind: 'agent'
  agent: string
  prompt: string
  folder: string | null
  retries: number
  onError: 'stop' | 'continue'
  timeoutMin: number
  /** Path of a subagent the agent's project defines; the step runs with that subagent's prompt and model */
  subagent?: string | null
}

/**
 * Has `agent` score what came in (`source`) against `rubric`, 1 to 10, and passes it on at `minScore` or more. Below it, `retryStep`
 * picks its conversation back up with the issues to fix, at most `rounds` times; after that it fails like an agent step
 */
export type JudgeNode = {
  id: string
  kind: 'judge'
  agent: string
  source: string
  rubric: string
  minScore: number
  retryStep: string | null
  rounds: number
  onError: 'stop' | 'continue'
}

export const MAX_SCORE = 10
export const MAX_ROUNDS = 5

export type ToolNode = { id: string; kind: 'tool'; tool: string; args: string }

export const WATCH_SOURCES = ['jira', 'notion'] as const

/**
 * Items a Jira JQL query or a Notion `Property = value` condition matches; each one that starts matching starts a run,
 * checked every few minutes while Treeix runs
 */
export type Watch = {
  id: string
  source: (typeof WATCH_SOURCES)[number]
  query: string
  dataSource?: string
  enabled: boolean
}

/** What a new watch looks for: items marked for an agent, yours, not done */
export const WATCH_QUERY: Record<Watch['source'], string> = {
  jira: 'labels = agent-ready AND assignee = currentUser() AND statusCategory != Done',
  notion: 'Agent = ready'
}

export const isWatch = (value: unknown): value is Watch =>
  isJson(value) &&
  isString(value.id) &&
  WATCH_SOURCES.some((source) => source === value.source) &&
  isString(value.query) &&
  (value.dataSource === undefined || isString(value.dataSource)) &&
  typeof value.enabled === 'boolean'

/** The ticket a watch started a run for */
export type Ticket = { key: string; url: string | null }

/** A ticket's text and comments, as the board's ticket dialog shows them */
export type TicketSource = 'jira' | 'notion'

/** A run started by a command schedule is titled `jira:BF-7 BF-7 Fix it` or `notion:<id> Title`: source, key, then the rest */
export const SOURCED_TITLE = /^(jira|notion):(\S+)\s*(.*)$/
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/** The Jira work item or Notion page a run is about: from a command schedule's title, else the ticket a watch started it for */
export function ticketOf(run: Pick<Run, 'title' | 'ticket'>): { source: TicketSource; key: string } | null {
  const [, source, key] = SOURCED_TITLE.exec(run.title) ?? []
  if (source === 'jira' || source === 'notion') return { source, key }
  if (!run.ticket) return null
  return { source: JIRA_KEY.test(run.ticket.key) ? 'jira' : 'notion', key: run.ticket.key }
}

export type TicketDetail = { title: string; url: string | null; body: string; comments: { author: string; created: string; body: string }[] }

export type WorkflowNode =
  /**
   * `schedules` start the workflow on their own while Treeix runs, each with its prompt as the input; `events` start it when a plugin emits one,
   * with the event's JSON as the input; `watches` start it once per new ticket, with the ticket's JSON as the input
   */
  | {
      id: string
      kind: 'input'
      schedules?: Schedule[]
      events?: string[]
      watches?: Watch[]
    }
  | AgentNode
  | { id: string; kind: 'merge' | 'output'; template: string }
  | { id: string; kind: 'condition'; source: string; test: 'contains' | 'equals' | 'regex' | 'empty'; value: string }
  /**
   * Pauses the run until the user approves `message`; passes what came in on, with the user's notes. `timeoutMin` overrides
   * when an agent decides instead; missing is the hub's setting. The user's reject with changes sends `retryStep`, an agent
   * step before it, back to redo its work with them; without one, or without changes, reject fails the run
   */
  | { id: string; kind: 'approval'; message: string; timeoutMin?: number | null; retryStep?: string | null }
  /** Calls a tool an enabled plugin offers; `args` is a JSON object template, its text reply is the output */
  | ToolNode
  | JudgeNode

export const KIND_LABEL: Record<WorkflowNode['kind'], string> = {
  input: 'Input',
  agent: 'Agent',
  merge: 'Merge',
  condition: 'Condition',
  approval: 'Approval',
  tool: 'Tool',
  judge: 'Review',
  output: 'Output'
}

/** `branch` is set on edges leaving a condition: only the side that matched runs */
export type Edge = { id: string; from: string; to: string; branch: 'true' | 'false' | null }

type Point = { x: number; y: number }

/** `layout` is where each step sits on the canvas; runs ignore it */
export type Workflow = { id: string; name: string; nodes: WorkflowNode[]; edges: Edge[]; layout: Record<string, Point>; updatedAt: number }

const KINDS: string[] = ['input', 'agent', 'merge', 'condition', 'approval', 'tool', 'judge', 'output'] satisfies WorkflowNode['kind'][]

/** Saved workflows come from the renderer; this keeps a malformed one out of the file */
export const isWorkflow = (value: unknown): value is Workflow =>
  isJson(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  Array.isArray(value.nodes) &&
  value.nodes.every(
    (node) =>
      isJson(node) &&
      typeof node.id === 'string' &&
      typeof node.kind === 'string' &&
      KINDS.includes(node.kind) &&
      (node.schedules === undefined || (Array.isArray(node.schedules) && node.schedules.every(isSchedule))) &&
      (node.events === undefined || (Array.isArray(node.events) && node.events.every(isString))) &&
      (node.watches === undefined || (Array.isArray(node.watches) && node.watches.every(isWatch)))
  ) &&
  Array.isArray(value.edges) &&
  value.edges.every((edge) => isJson(edge) && typeof edge.from === 'string' && typeof edge.to === 'string') &&
  isJson(value.layout) &&
  typeof value.updatedAt === 'number'

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export type NodeRun = {
  status: NodeStatus
  attempt: number
  startedAt: number | null
  endedAt: number | null
  prompt: string | null
  output: string | null
  branch: 'true' | 'false' | null
  error: string | null
  usage: { used: number; cost: number | null } | null
  /** A running node held up by the user: an approval step, or an agent asking for permission */
  waiting?: 'approval' | 'permission' | null
  /** The agent step's conversation, which Continue in chat resumes */
  sessionId?: string | null
  /** The last approval or permission answer, and who gave it where */
  decision?: Decision | null
  /** A judge step's last score, and which round of fixes it was */
  review?: Review | null
}

export type Review = { score: number; issues: string[]; round: number }

/** `Scored 6/10 in round 2: <issue>; <issue>` */
export const reviewText = (review: Review): string =>
  `Scored ${review.score}/${MAX_SCORE}${review.round > 1 ? ` in round ${review.round}` : ''}${review.issues.length ? `: ${review.issues.join('; ')}` : ''}`

/** An answer to an approval or a permission: the user's from somewhere, or an agent's once nobody replied in time */
export type Decision = { approved: boolean; by: 'you' | 'agent' | 'eval'; via: 'app' | 'web' | TicketSource; reason: string | null; at: number }

export type Decider = Pick<Decision, 'by' | 'via' | 'reason'>

export const FROM_APP: Decider = { by: 'you', via: 'app', reason: null }

const VIA: Record<Decision['via'], string> = { app: 'in Treeix', web: 'from your phone', jira: 'in Jira', notion: 'in Notion' }

/** `Approved by you in Jira`, `Rejected by an agent, as nobody replied in time: <why>` */
export const decisionText = (decision: Decision): string =>
  `${decision.approved ? 'Approved' : 'Rejected'} ${{ agent: 'by an agent, as nobody replied in time', eval: 'by the eval', you: `by you ${VIA[decision.via]}` }[decision.by]}${decision.reason ? `: ${decision.reason}` : ''}`

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export type Run = {
  id: string
  /** `schedule` is an ask an agent's schedule started, `eval` a case of an eval suite, kept off the board */
  kind: 'workflow' | 'ask' | 'schedule' | 'eval'
  title: string
  workflow: Workflow
  input: string
  status: RunStatus
  startedAt: number
  endedAt: number | null
  nodes: Record<string, NodeRun>
  output: string | null
  /** Set when a watch started the run */
  ticket?: Ticket | null
}

/** One logged chat event of a node, as stored and streamed */
export type RunEvent = { node: string; at: number; event: ChatEvent }

export const isRunEvent = (value: unknown): value is RunEvent => isJson(value) && typeof value.node === 'string' && typeof value.at === 'number' && isJson(value.event)

/** How an agent chats and where it works, as the renderer last reported */
export type AgentRuntime = ChatSpec & { agent: string; cwd: string }

export const ASK_TIMEOUT_MIN = 10

/** A question to one agent, run as input → agent → output so it shows like any run */
export function askWorkflow(agent: string, folder: string | null, timeoutMin = ASK_TIMEOUT_MIN): Workflow {
  return {
    id: 'ask',
    name: 'Ask',
    nodes: [
      { id: 'input', kind: 'input' },
      { id: 'agent', kind: 'agent', agent, prompt: '{{input}}', folder, retries: 0, onError: 'stop', timeoutMin },
      { id: 'output', kind: 'output', template: '{{prev}}' }
    ],
    edges: [
      { id: 'input-agent', from: 'input', to: 'agent', branch: null },
      { id: 'agent-output', from: 'agent', to: 'output', branch: null }
    ],
    layout: {},
    updatedAt: 0
  }
}

export const freshNode = (): NodeRun => ({ status: 'pending', attempt: 0, startedAt: null, endedAt: null, prompt: null, output: null, branch: null, error: null, usage: null })

export const isWaiting = (run: Run): boolean => run.status === 'running' && Object.values(run.nodes).some((node) => node.waiting)

/** The agents some running step is asking right now, each counted once */
export const activeAgents = (runs: Run[]): Set<string> =>
  new Set(
    runs
      .filter((run) => run.status === 'running')
      .flatMap((run) =>
        run.workflow.nodes
          .filter((node): node is AgentNode | JudgeNode => (node.kind === 'agent' || node.kind === 'judge') && run.nodes[node.id]?.status === 'running')
          .map((node) => node.agent)
      )
  )

/** Runs are written by the app; this only keeps a damaged file from reaching the UI */
export const isRun = (value: unknown): value is Run =>
  isJson(value) && typeof value.id === 'string' && typeof value.status === 'string' && isJson(value.workflow) && isJson(value.nodes) && typeof value.startedAt === 'number'
