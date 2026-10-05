import type { ChatEvent, ChatSpec } from '@treeix/sdk/main'
import { isJson } from '@treeix/shared/json'

/** An agent node's run: one fresh session, one prompt, the reply as its output */
export type AgentNode = { id: string; kind: 'agent'; agent: string; prompt: string; folder: string | null; retries: number; onError: 'stop' | 'continue'; timeoutMin: number }

export type WorkflowNode =
  | { id: string; kind: 'input' }
  | AgentNode
  | { id: string; kind: 'merge' | 'output'; template: string }
  | { id: string; kind: 'condition'; source: string; test: 'contains' | 'equals' | 'regex' | 'empty'; value: string }
  /** Pauses the run until the user approves `message`; passes what came in on */
  | { id: string; kind: 'approval'; message: string }

/** `branch` is set on edges leaving a condition: only the side that matched runs */
export type Edge = { id: string; from: string; to: string; branch: 'true' | 'false' | null }

type Point = { x: number; y: number }

/** `layout` is where each step sits on the canvas; runs ignore it */
export type Workflow = { id: string; name: string; nodes: WorkflowNode[]; edges: Edge[]; layout: Record<string, Point>; updatedAt: number }

const KINDS: string[] = ['input', 'agent', 'merge', 'condition', 'approval', 'output'] satisfies WorkflowNode['kind'][]

/** Saved workflows come from the renderer; this keeps a malformed one out of the file */
export const isWorkflow = (value: unknown): value is Workflow =>
  isJson(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  Array.isArray(value.nodes) &&
  value.nodes.every((node) => isJson(node) && typeof node.id === 'string' && typeof node.kind === 'string' && KINDS.includes(node.kind)) &&
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
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export type Run = {
  id: string
  /** `schedule` is an ask an agent's schedule started */
  kind: 'workflow' | 'ask' | 'schedule'
  title: string
  workflow: Workflow
  input: string
  status: RunStatus
  startedAt: number
  endedAt: number | null
  nodes: Record<string, NodeRun>
  output: string | null
}

/** One logged chat event of a node, as stored and streamed */
export type RunEvent = { node: string; at: number; event: ChatEvent }

export const isRunEvent = (value: unknown): value is RunEvent => isJson(value) && typeof value.node === 'string' && typeof value.at === 'number' && isJson(value.event)

/** How an agent chats and where it works, as the renderer last reported */
export type AgentRuntime = ChatSpec & { agent: string; cwd: string }

export const ASK_TIMEOUT_MIN = 10

/** A question to one agent, run as input → agent → output so it shows like any run */
export function askWorkflow(agent: string, folder: string | null): Workflow {
  return {
    id: 'ask',
    name: 'Ask',
    nodes: [
      { id: 'input', kind: 'input' },
      { id: 'agent', kind: 'agent', agent, prompt: '{{input}}', folder, retries: 0, onError: 'stop', timeoutMin: ASK_TIMEOUT_MIN },
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
      .flatMap((run) => run.workflow.nodes.filter((node): node is AgentNode => node.kind === 'agent' && run.nodes[node.id]?.status === 'running').map((node) => node.agent))
  )

/** Runs are written by the app; this only keeps a damaged file from reaching the UI */
export const isRun = (value: unknown): value is Run =>
  isJson(value) && typeof value.id === 'string' && typeof value.status === 'string' && isJson(value.workflow) && isJson(value.nodes) && typeof value.startedAt === 'number'
