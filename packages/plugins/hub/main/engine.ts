import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ChatAdapter, ChatConnection, ChatEvent } from '@treeix/sdk/main'
import { createBatcher } from '@treeix/host/batcher'
import { agentDirectories } from '@treeix/host/projects'
import { isJson, isString } from '@treeix/shared/json'
import { render, renderArgs, type TemplateScope } from '../shared/template'
import { descendants } from '../shared/validate'
import {
  type AgentNode,
  type AgentRuntime,
  askWorkflow,
  type Decider,
  FROM_APP,
  freshNode,
  type JudgeNode,
  MAX_SCORE,
  type NodeRun,
  type Review,
  type Run,
  type RunEvent,
  type RunStatus,
  type ToolNode,
  type Workflow
} from '../shared/workflow'
import { holds, isLive, nextSteps } from './schedule'
import { resolveSubagent } from './subagents'
import { KEEP_RUNS, mergeChunks, type Runs } from './runs'

const MAX_AGENTS = 3
const EVENTS_DELAY_MS = 250
const TITLE_CHARS = 80
const RESUME_PROMPT = 'The app quit while you were on this. Continue where you stopped. In case the conversation is gone, the task was:'
const JUDGE_TIMEOUT_MIN = 30
/** A repo's subagent is written for someone at the keyboard; a step runs with nobody watching */
const AS_SUBAGENT =
  'You work as the repo subagent whose instructions follow. Where they clash with the task you are given, the task wins: nobody watches this run, so ask no one and wait for no approval.'
const REPLY_JSON = /\{[\s\S]*\}/

/** A judge's score from its reply; anything but a 1 to 10 score throws */
export function parseReview(reply: string): Omit<Review, 'round'> {
  let review: unknown = null
  try {
    review = JSON.parse(REPLY_JSON.exec(reply)?.[0] ?? '')
  } catch {
    // No JSON: thrown below
  }
  const score = isJson(review) ? Number(review.score) : NaN
  if (!isJson(review) || !(score >= 1 && score <= MAX_SCORE)) throw new Error(`The judge gave no score: ${reply.slice(0, 200)}`)
  return { score, issues: Array.isArray(review.issues) ? review.issues.filter(isString) : [] }
}

type Fix = Omit<Review, 'round'> & { minScore: number }

const judgePrompt = (work: string, rubric: string): string =>
  [
    "You review another agent's work. Change no code: read what you need, run the checks asked for, and score it.",
    `The work:\n${work}`,
    `Judge it by:\n${rubric}`,
    `Reply with only a JSON object: {"score": 1 to ${MAX_SCORE}, "issues": ["one thing to fix per item"]}. ${MAX_SCORE} means ready to ship as is; list everything that keeps it from that.`
  ].join('\n\n')

const fixPrompt = ({ score, issues, minScore }: Fix, task: string): string =>
  [
    `A reviewer scored your work ${score}/${MAX_SCORE}; it needs ${minScore}. Fix these, then reply as the task asks:`,
    issues.map((issue) => `- ${issue}`).join('\n') || '- (no details given) Check the work against the task again.',
    `The task, for reference:\n${task}`
  ].join('\n\n')

const changesPrompt = (changes: string, task: string): string =>
  [
    'The user read your work and wants changes before the run goes on:',
    changes,
    'Redo it with these in mind, then reply as the task asks.',
    `The task, for reference:\n${task}`
  ].join('\n\n')
// Options, commands and usage are session state, not part of what the agent did
const LOGGED = new Set<ChatEvent['type']>([
  'message_chunk',
  'thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'permission',
  'permission_settled',
  'turn_start',
  'turn_end',
  'error',
  'disconnected'
])

type Active = {
  run: Run
  /** Asked by another agent through hub_ask: no Treeix tools, so it can't ask on, and its own slots, so askers can't starve it */
  delegated: boolean
  connections: Map<string, ChatConnection>
  events: RunEvent[]
  log: (event: RunEvent) => void
  flush: () => void
  /** Rejects when the run ends early, to unblock agents that ignore a cancel */
  stopped: Promise<never>
  stop: (reason: Error) => void
  finished: Promise<Run>
  finish: (run: Run) => void
  /** Steps that pick their conversation back up instead of starting one, by node id */
  resumes: Map<string, string>
  /** Open permission questions, by `<node>:<requestId>` */
  permissions: Map<string, Question>
  /** What a judge or an approval sends back for a step to redo, by node id; wraps the task once */
  fixes: Map<string, (task: string) => string>
}

/** A permission question an agent step waits on */
export type Question = Extract<ChatEvent, { type: 'permission' }> & { node: string }

/** Hands out at most `size` slots; a released slot goes straight to the longest waiter */
function createLimiter(size: number): { acquire: () => Promise<void>; release: () => void } {
  let used = 0
  const waiting: (() => void)[] = []
  return {
    acquire: async () => {
      if (used < size) return void used++
      await new Promise<void>((resolve) => waiting.push(resolve))
    },
    release: () => {
      const next = waiting.shift()
      if (next) next()
      else used--
    }
  }
}

export function createEngine(deps: {
  adapter: (id: string) => ChatAdapter | null
  runtime: (agent: string) => Promise<AgentRuntime | null>
  /** Whether the agent allows every permission it asks for */
  autoApprove: (agent: string) => Promise<boolean>
  sessionEnv: () => Promise<Record<string, string>>
  /** Runs a tool some plugin offers; throws when the call fails */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  runs: Runs
  onRun: (run: Run) => void
  onEvents: (runId: string, events: RunEvent[]) => void
}) {
  const active = new Map<string, Active>()
  const slots = createLimiter(MAX_AGENTS)
  const delegatedSlots = createLimiter(MAX_AGENTS)

  const publish = (run: Run): void => {
    void deps.runs.save(run)
    deps.onRun(run)
  }

  const set = (entry: Active, id: string, change: Partial<NodeRun>): void => {
    entry.run = { ...entry.run, nodes: { ...entry.run.nodes, [id]: { ...entry.run.nodes[id], ...change } } }
    publish(entry.run)
  }

  const end = (entry: Active, status: RunStatus, error: Error | null = null): void => {
    if (entry.run.status !== 'running') return
    const now = Date.now()
    const nodes = Object.fromEntries(
      Object.entries(entry.run.nodes).map(([id, node]) => [id, node.status === 'running' ? { ...node, status: 'cancelled' as const, endedAt: now, waiting: null } : node])
    )
    const outputs = entry.run.workflow.nodes.flatMap((node) => (node.kind === 'output' && nodes[node.id].status === 'done' ? [nodes[node.id].output ?? ''] : []))
    entry.run = { ...entry.run, status, endedAt: now, nodes, output: outputs.length ? outputs.join('\n\n') : null }
    if (error) entry.stop(error)
    entry.connections.forEach((connection) => connection.close())
    entry.flush()
    publish(entry.run)
    active.delete(entry.run.id)
    entry.finish(entry.run)
  }

  /** One session, one prompt; the reply is the text after the agent's last tool call, the part that answers */
  async function attempt(entry: Active, node: AgentNode, prompt: string): Promise<string> {
    // Only the first attempt resumes; a retry after it starts clean
    const resume = entry.resumes.get(node.id) ?? null
    entry.resumes.delete(node.id)
    const runtime = await deps.runtime(node.agent)
    if (!runtime) throw new Error('The agent is gone, or its runtime is')
    const adapter = deps.adapter(runtime.adapter)
    if (!adapter) throw new Error(`Nothing runs ${runtime.adapter} agents; is its plugin on?`)
    const autoApprove = await deps.autoApprove(node.agent)
    // A step can run as a subagent the projects already define, instead of the hub needing an agent per role; a project without it gets the agent itself
    const cwd = node.folder ?? entry.run.folder ?? runtime.cwd
    const subagent = node.subagent ? await resolveSubagent(node.subagent, cwd) : null
    entry.log({ node: node.id, at: Date.now(), event: { type: 'message_chunk', role: 'user', content: { type: 'text', text: prompt } } })
    const connecting = adapter.connect({
      command: runtime.command,
      instructions: subagent ? [runtime.instructions, AS_SUBAGENT, subagent.instructions].filter(Boolean).join('\n\n') : runtime.instructions,
      preset: subagent?.model ? { ...runtime.preset, model: subagent.model } : runtime.preset,
      // A folder of several repos, or a worktree whose repo adds folders: the agent loads those too (home's are the user's own)
      directories: runtime.directories ?? (cwd === homedir() ? undefined : await agentDirectories(cwd)),
      cwd,
      env: entry.delegated ? {} : await deps.sessionEnv(),
      resume
    })
    const connection = await Promise.race([connecting, entry.stopped]).catch((error: unknown) => {
      // Stopped while the agent was starting: close it once it's up
      connecting.then(
        (late) => late.close(),
        () => undefined
      )
      throw error
    })
    entry.connections.set(node.id, connection)
    set(entry, node.id, { sessionId: connection.sessionId })
    let reply = ''
    let failure: string | null = null
    // Permissions nobody has answered yet; while any is open the node waits on the user
    const asking = new Set<string>()
    const unfollow = connection.onEvent((event) => {
      if (event.type === 'usage') set(entry, node.id, { usage: { used: event.used, cost: event.cost?.amount ?? null } })
      if (!LOGGED.has(event.type)) return
      entry.log({ node: node.id, at: Date.now(), event })
      if (event.type === 'permission') {
        const allow = event.options.find((option) => option.kind === 'allow_once') ?? event.options.find((option) => option.kind === 'allow_always')
        if (autoApprove && allow) return connection.answer(event.requestId, allow.id)
        asking.add(event.requestId)
        entry.permissions.set(`${node.id}:${event.requestId}`, { ...event, node: node.id })
        set(entry, node.id, { waiting: 'permission' })
      }
      if (event.type === 'permission_settled') entry.permissions.delete(`${node.id}:${event.requestId}`)
      if (event.type === 'permission_settled' && asking.delete(event.requestId) && !asking.size) set(entry, node.id, { waiting: null })
      // The node's answer is its own agent's last reply, never a subagent's
      if (event.type === 'tool_call' && !event.parent) reply = ''
      if (event.type === 'message_chunk' && !event.parent && event.role === 'agent' && event.content.type === 'text') reply += event.content.text
      if (event.type === 'error' || event.type === 'disconnected') failure = event.message
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`No answer within ${node.timeoutMin} min`)), node.timeoutMin * 60_000)))
    try {
      const { stopReason } = await Promise.race([connection.prompt([{ type: 'text', text: prompt }]), timeout, entry.stopped])
      if (stopReason === 'cancelled') throw new Error(failure ?? 'Cancelled')
      return reply.trim()
    } finally {
      clearTimeout(timer)
      unfollow()
      connection.close()
      entry.connections.delete(node.id)
    }
  }

  async function runAgent(entry: Active, node: AgentNode, prompt: string): Promise<void> {
    const pool = entry.delegated ? delegatedSlots : slots
    await pool.acquire()
    try {
      for (let count = 1; entry.run.status === 'running'; count++) {
        set(entry, node.id, { attempt: count, startedAt: Date.now(), error: null })
        try {
          set(entry, node.id, { status: 'done', output: await attempt(entry, node, prompt), endedAt: Date.now() })
          break
        } catch (error) {
          if (entry.run.status !== 'running') return
          const message = error instanceof Error ? error.message : String(error)
          if (count <= node.retries) continue
          set(entry, node.id, { status: 'failed', error: message, endedAt: Date.now() })
          if (node.onError === 'stop') end(entry, 'failed')
          break
        }
      }
    } finally {
      pool.release()
    }
    step(entry)
  }

  /** Scores the work; below the bar it sends `retryStep` back with the issues while rounds are left, else fails like an agent step */
  async function runJudge(entry: Active, node: JudgeNode, work: string, prompt: string): Promise<void> {
    const retry = entry.run.workflow.nodes.find((candidate): candidate is AgentNode => candidate.kind === 'agent' && candidate.id === node.retryStep)
    const judge: AgentNode = {
      id: node.id,
      kind: 'agent',
      agent: node.agent,
      prompt,
      // Where the work it judges was done
      folder: retry?.folder ?? null,
      retries: 0,
      onError: 'stop',
      timeoutMin: JUDGE_TIMEOUT_MIN
    }
    const pool = entry.delegated ? delegatedSlots : slots
    await pool.acquire()
    let review: Review
    try {
      review = { ...parseReview(await attempt(entry, judge, prompt)), round: (entry.run.nodes[node.id].review?.round ?? 0) + 1 }
    } catch (error) {
      if (entry.run.status !== 'running') return
      set(entry, node.id, { status: 'failed', output: work, error: error instanceof Error ? error.message : String(error), endedAt: Date.now() })
      if (node.onError === 'stop') end(entry, 'failed')
      return step(entry)
    } finally {
      pool.release()
    }
    if (entry.run.status !== 'running') return
    if (review.score >= node.minScore) set(entry, node.id, { status: 'done', output: work, endedAt: Date.now(), review })
    else if (retry && review.round <= node.rounds) sendBack(entry, node.id, retry, (task) => fixPrompt({ ...review, minScore: node.minScore }, task), { review })
    else {
      set(entry, node.id, { status: 'failed', output: work, error: `Scored ${review.score}/${MAX_SCORE}, needs ${node.minScore}`, endedAt: Date.now(), review })
      if (node.onError === 'stop') end(entry, 'failed')
    }
    step(entry)
  }

  /**
   * Starts `retry` and what follows it over, the step resuming its conversation with `fix` around its task; the step that
   * sent it back keeps `kept`: a judge its review to count rounds, an approval its decision
   */
  function sendBack(entry: Active, from: string, retry: AgentNode, fix: (task: string) => string, kept: Partial<NodeRun>): void {
    const { run } = entry
    const sessionId = run.nodes[retry.id].sessionId
    if (sessionId) entry.resumes.set(retry.id, sessionId)
    entry.fixes.set(retry.id, fix)
    // A parallel branch still going finishes on its own
    const reset = [retry.id, ...descendants(run.workflow, retry.id)].filter((id) => id === from || run.nodes[id].status !== 'running')
    entry.run = { ...run, nodes: { ...run.nodes, ...Object.fromEntries(reset.map((id) => [id, freshNode()])), [from]: { ...freshNode(), ...kept } } }
    publish(entry.run)
  }

  /** A failed call ends the run, so a retry from this step redoes only what didn't happen */
  async function runTool(entry: Active, node: ToolNode, scope: TemplateScope): Promise<void> {
    try {
      const args = renderArgs(node.args, scope)
      set(entry, node.id, { status: 'running', prompt: JSON.stringify(args, null, 2), attempt: 1, startedAt: Date.now() })
      const output = await Promise.race([deps.callTool(node.tool, args), entry.stopped])
      set(entry, node.id, { status: 'done', output, endedAt: Date.now() })
    } catch (error) {
      if (entry.run.status !== 'running') return
      set(entry, node.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), endedAt: Date.now() })
      return end(entry, 'failed')
    }
    step(entry)
  }

  /** Starts every node whose inputs are in, skips what can't run, and ends the run once nothing is left */
  function step(entry: Active): void {
    for (let progress = true; progress && entry.run.status === 'running';) {
      const { ready, skip } = nextSteps(entry.run.workflow, entry.run.nodes)
      progress = ready.length + skip.length > 0
      for (const id of skip) set(entry, id, { status: 'skipped' })
      for (const id of ready) start(entry, id)
    }
    if (entry.run.status === 'running' && !Object.values(entry.run.nodes).some((node) => node.status === 'running')) end(entry, 'done')
  }

  const scopeOf = (run: Run, id: string): TemplateScope => {
    const outputs = Object.fromEntries(Object.entries(run.nodes).flatMap(([key, value]) => (value.output === null ? [] : [[key, value.output]])))
    const prev = run.workflow.edges
      .filter((edge) => edge.to === id && isLive(edge, run.nodes))
      .map((edge) => run.nodes[edge.from].output ?? '')
      .filter(Boolean)
      .join('\n\n')
    return { input: run.input, prev, outputs }
  }

  function start(entry: Active, id: string): void {
    const { run } = entry
    const node = run.workflow.nodes.find((candidate) => candidate.id === id)
    if (!node) return
    const scope = scopeOf(run, id)
    const now = Date.now()
    const finished = (output: string, change: Partial<NodeRun> = {}): void => set(entry, id, { status: 'done', output, startedAt: now, endedAt: now, ...change })
    switch (node.kind) {
      case 'input':
        return finished(run.input)
      case 'merge':
      case 'output':
        return finished(render(node.template, scope))
      case 'condition': {
        const source = render(node.source, scope)
        try {
          return finished(source, { branch: holds(node, source) ? 'true' : 'false' })
        } catch (error) {
          set(entry, id, { status: 'failed', error: error instanceof Error ? error.message : String(error), startedAt: now, endedAt: now })
          return end(entry, 'failed')
        }
      }
      case 'approval':
        return set(entry, id, { status: 'running', prompt: render(node.message, scope), startedAt: now, waiting: 'approval' })
      case 'tool':
        set(entry, id, { status: 'running', startedAt: now })
        return void runTool(entry, node, scope)
      case 'agent': {
        const task = render(node.prompt, scope)
        const fix = entry.fixes.get(id)
        entry.fixes.delete(id)
        const prompt = fix ? fix(task) : entry.resumes.has(id) ? `${RESUME_PROMPT}\n\n${task}` : task
        set(entry, id, { status: 'running', prompt })
        return void runAgent(entry, node, prompt)
      }
      case 'judge': {
        const work = render(node.source, scope)
        const prompt = judgePrompt(work, render(node.rubric, scope))
        set(entry, id, { status: 'running', prompt, startedAt: now })
        void runJudge(entry, node, work, prompt)
      }
    }
  }

  /** Makes a run live: its events batch to disk and to windows, and it can be stepped */
  function track(run: Run, events: RunEvent[], delegated: boolean): Active {
    let stop: (reason: Error) => void = () => undefined
    const stopped = new Promise<never>((_, reject) => (stop = reject))
    stopped.catch(() => undefined)
    let finish: (run: Run) => void = () => undefined
    const finished = new Promise<Run>((resolve) => (finish = resolve))
    const batcher = createBatcher<RunEvent>((batch) => {
      const merged = mergeChunks(batch)
      events.push(...merged)
      void deps.runs.append(run.id, merged)
      deps.onEvents(run.id, merged)
    }, EVENTS_DELAY_MS)
    const entry: Active = {
      run,
      delegated,
      connections: new Map(),
      events,
      log: batcher.push,
      flush: batcher.flush,
      stopped,
      stop,
      finished,
      finish,
      resumes: new Map(),
      permissions: new Map(),
      fixes: new Map()
    }
    active.set(run.id, entry)
    return entry
  }

  /** Only approval steps hold it: nothing is lost when the app quits, so it waits on after a relaunch */
  const onlyApprovals = (run: Run): boolean => Object.values(run.nodes).every((node) => node.status !== 'running' || node.waiting === 'approval')

  function launch(kind: Run['kind'], title: string, workflow: Workflow, input: string, delegated = false, about: Pick<Run, 'ticket' | 'folder'> = {}): Run {
    const run: Run = {
      id: randomUUID(),
      kind,
      title,
      workflow,
      input,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      nodes: Object.fromEntries(workflow.nodes.map((node) => [node.id, freshNode()])),
      output: null,
      ...about
    }
    const entry = track(run, [], delegated)
    publish(run)
    // Eval runs keep their own count, so a suite's runs never push the user's out; a ticket's runs stay as its audit trail
    void deps.runs.list().then((runs) =>
      deps.runs.remove(
        [false, true].flatMap((evals) =>
          runs
            .filter((old) => (old.kind === 'eval') === evals && !old.ticket)
            .slice(KEEP_RUNS)
            .map((old) => old.id)
        )
      )
    )
    step(entry)
    return entry.run
  }

  /** Runs an ended run again from `node` and every step the end cut short; with `resuming`, cut-short agents keep their conversation */
  async function rerun(id: string, node: string | null, resuming: boolean): Promise<void> {
    if (active.has(id)) throw new Error('The run is still going')
    const run = (await deps.runs.list()).find((candidate) => candidate.id === id)
    if (!run || (node !== null && !run.nodes[node])) throw new Error('The run is gone')
    const cut = Object.keys(run.nodes).filter((key) => key === node || run.nodes[key].status === 'cancelled')
    const reset = new Set(cut.flatMap((key) => [key, ...descendants(run.workflow, key)]))
    const nodes = Object.fromEntries(Object.entries(run.nodes).map(([key, value]) => [key, reset.has(key) ? freshNode() : value]))
    const entry = track({ ...run, status: 'running', endedAt: null, output: null, nodes }, await deps.runs.events(id), false)
    for (const key of resuming ? cut : []) {
      const sessionId = run.nodes[key].sessionId
      if (sessionId) entry.resumes.set(key, sessionId)
    }
    publish(entry.run)
    step(entry)
  }

  return {
    launch,
    ask: (agent: string, message: string, folder: string | null, delegated: boolean): Run =>
      launch('ask', message.trim().split('\n')[0].slice(0, TITLE_CHARS), askWorkflow(agent, folder), message, delegated),
    /** Resolves once the run ends */
    wait: async (id: string): Promise<Run | null> => active.get(id)?.finished ?? (await deps.runs.list()).find((run) => run.id === id) ?? null,
    list: async (): Promise<Run[]> => {
      const stored = await deps.runs.list()
      const live = [...active.values()].map((entry) => entry.run)
      return [...live, ...stored.filter((run) => !active.has(run.id))].sort((a, b) => b.startedAt - a.startedAt)
    },
    /** Drops an ended run from the history; a live one stays */
    remove: async (id: string): Promise<boolean> => {
      if (active.has(id)) return false
      await deps.runs.remove([id])
      return true
    },
    /** A live run's events come from memory, so they line up with the batches broadcast after */
    events: (id: string): RunEvent[] | Promise<RunEvent[]> => active.get(id)?.events ?? deps.runs.events(id),
    cancel: (id: string): void => {
      const entry = active.get(id)
      if (entry) end(entry, 'cancelled', new Error('Cancelled'))
    },
    /** The permission questions a live run waits on */
    questions: (id: string): Question[] => [...(active.get(id)?.permissions.values() ?? [])],
    /** Answers a permission question; allowing counts as approving it */
    answer: (id: string, node: string, requestId: string, optionId: string | null, who: Decider = FROM_APP): void => {
      const entry = active.get(id)
      const connection = entry?.connections.get(node)
      const question = entry?.permissions.get(`${node}:${requestId}`)
      if (!entry || !connection || !question) return
      const approved = question.options.some((option) => option.id === optionId && option.kind.startsWith('allow'))
      set(entry, node, { decision: { approved, ...who, at: Date.now() } })
      connection.answer(requestId, optionId)
    },
    /**
     * Approves an approval step, passing what came in on with the user's notes, or rejects it, which fails the run; the user's
     * reject with changes sends the step's `retryStep` back to redo its work with them instead
     */
    decide: (id: string, node: string, approved: boolean, who: Decider = FROM_APP): void => {
      const entry = active.get(id)
      if (entry?.run.nodes[node]?.waiting !== 'approval') return
      const decision = { approved, ...who, at: Date.now() }
      const approval = entry.run.workflow.nodes.find((candidate) => candidate.id === node)
      const retry =
        approval?.kind === 'approval'
          ? entry.run.workflow.nodes.find((candidate): candidate is AgentNode => candidate.kind === 'agent' && candidate.id === approval.retryStep)
          : undefined
      const changes = who.by === 'you' ? who.reason : null
      if (!approved && retry && changes) {
        sendBack(entry, node, retry, (task) => changesPrompt(changes, task), { decision })
        return step(entry)
      }
      if (!approved) {
        set(entry, node, { status: 'failed', error: 'Rejected', endedAt: Date.now(), waiting: null, decision })
        return end(entry, 'failed')
      }
      const { prev } = scopeOf(entry.run, node)
      set(entry, node, { status: 'done', output: changes ? `${prev}\n\nNotes from the approval: ${changes}` : prev, endedAt: Date.now(), waiting: null, decision })
      step(entry)
    },
    /** Runs an ended run again from `node`: it, everything after it and every step the end cut short start over */
    retry: (id: string, node: string): Promise<void> => rerun(id, node, false),
    /** Continues a run the app quit under: steps it cut short pick their conversations back up, the rest start over */
    resume: (id: string): Promise<void> => rerun(id, null, true),
    /** Runs that were going when the app last quit: those held only by approvals wait on, the rest are marked interrupted; resolves with those */
    recover: async (): Promise<string[]> => {
      const runs = await deps.runs.list()
      const interrupted: string[] = []
      for (const run of runs.filter((candidate) => candidate.status === 'running' && !active.has(candidate.id))) {
        if (onlyApprovals(run)) {
          track(run, await deps.runs.events(run.id), false)
          continue
        }
        const nodes = Object.fromEntries(
          Object.entries(run.nodes).map(([id, node]) => [id, node.status === 'running' ? { ...node, status: 'cancelled' as const, waiting: null } : node])
        )
        void deps.runs.save({ ...run, status: 'interrupted', nodes })
        interrupted.push(run.id)
      }
      return interrupted
    },
    /** Stops every run, keeping approvals waiting; replies with the ids it interrupted */
    dispose: (): string[] =>
      [...active.values()].flatMap((entry) => {
        if (!onlyApprovals(entry.run)) return (end(entry, 'interrupted', new Error('Interrupted')), [entry.run.id])
        entry.flush()
        active.delete(entry.run.id)
        return []
      })
  }
}
