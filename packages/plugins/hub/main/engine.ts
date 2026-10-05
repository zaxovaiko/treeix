import { randomUUID } from 'node:crypto'
import type { ChatAdapter, ChatConnection, ChatEvent } from '@treeix/sdk/main'
import { createBatcher } from '@treeix/host/batcher'
import { render, type TemplateScope } from '../shared/template'
import { descendants } from '../shared/validate'
import { type AgentNode, type AgentRuntime, askWorkflow, freshNode, type NodeRun, type Run, type RunEvent, type RunStatus, type Workflow } from '../shared/workflow'
import { holds, isLive, nextSteps } from './schedule'
import { KEEP_RUNS, mergeChunks, type Runs } from './runs'

const MAX_AGENTS = 3
const EVENTS_DELAY_MS = 250
const TITLE_CHARS = 80
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
}

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
    const runtime = await deps.runtime(node.agent)
    if (!runtime) throw new Error('The agent is gone, or its runtime is')
    const adapter = deps.adapter(runtime.adapter)
    if (!adapter) throw new Error(`Nothing runs ${runtime.adapter} agents; is its plugin on?`)
    const autoApprove = await deps.autoApprove(node.agent)
    entry.log({ node: node.id, at: Date.now(), event: { type: 'message_chunk', role: 'user', content: { type: 'text', text: prompt } } })
    const connecting = adapter.connect({
      command: runtime.command,
      instructions: runtime.instructions,
      preset: runtime.preset,
      cwd: node.folder ?? runtime.cwd,
      env: entry.delegated ? {} : await deps.sessionEnv(),
      resume: null
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
        set(entry, node.id, { waiting: 'permission' })
      }
      if (event.type === 'permission_settled' && asking.delete(event.requestId) && !asking.size) set(entry, node.id, { waiting: null })
      if (event.type === 'tool_call') reply = ''
      if (event.type === 'message_chunk' && event.role === 'agent' && event.content.type === 'text') reply += event.content.text
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
      case 'agent': {
        const prompt = render(node.prompt, scope)
        set(entry, id, { status: 'running', prompt })
        void runAgent(entry, node, prompt)
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
    const entry: Active = { run, delegated, connections: new Map(), events, log: batcher.push, flush: batcher.flush, stopped, stop, finished, finish }
    active.set(run.id, entry)
    return entry
  }

  /** Only approval steps hold it: nothing is lost when the app quits, so it waits on after a relaunch */
  const onlyApprovals = (run: Run): boolean => Object.values(run.nodes).every((node) => node.status !== 'running' || node.waiting === 'approval')

  function launch(kind: Run['kind'], title: string, workflow: Workflow, input: string, delegated = false): Run {
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
      output: null
    }
    const entry = track(run, [], delegated)
    publish(run)
    void deps.runs.list().then((runs) => deps.runs.remove(runs.slice(KEEP_RUNS).map((old) => old.id)))
    step(entry)
    return entry.run
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
    /** A live run's events come from memory, so they line up with the batches broadcast after */
    events: (id: string): RunEvent[] | Promise<RunEvent[]> => active.get(id)?.events ?? deps.runs.events(id),
    cancel: (id: string): void => {
      const entry = active.get(id)
      if (entry) end(entry, 'cancelled', new Error('Cancelled'))
    },
    answer: (id: string, node: string, requestId: string, optionId: string | null): void => active.get(id)?.connections.get(node)?.answer(requestId, optionId),
    /** Approves an approval step, passing what came in on, or rejects it, which fails the run */
    decide: (id: string, node: string, approved: boolean): void => {
      const entry = active.get(id)
      if (entry?.run.nodes[node]?.waiting !== 'approval') return
      if (!approved) {
        set(entry, node, { status: 'failed', error: 'Rejected', endedAt: Date.now(), waiting: null })
        return end(entry, 'failed')
      }
      set(entry, node, { status: 'done', output: scopeOf(entry.run, node).prev, endedAt: Date.now(), waiting: null })
      step(entry)
    },
    /** Runs an ended run again from `node`: it, everything after it and every step the end cut short start over */
    retry: async (id: string, node: string): Promise<void> => {
      if (active.has(id)) throw new Error('The run is still going')
      const run = (await deps.runs.list()).find((candidate) => candidate.id === id)
      if (!run?.nodes[node]) throw new Error('The run is gone')
      const cut = Object.keys(run.nodes).filter((key) => key === node || run.nodes[key].status === 'cancelled')
      const reset = new Set(cut.flatMap((key) => [key, ...descendants(run.workflow, key)]))
      const nodes = Object.fromEntries(Object.entries(run.nodes).map(([key, value]) => [key, reset.has(key) ? freshNode() : value]))
      const entry = track({ ...run, status: 'running', endedAt: null, output: null, nodes }, await deps.runs.events(id), false)
      publish(entry.run)
      step(entry)
    },
    /** Runs that were going when the app last quit: those held only by approvals wait on, the rest can't continue */
    recover: async (): Promise<void> => {
      const runs = await deps.runs.list()
      for (const run of runs.filter((candidate) => candidate.status === 'running' && !active.has(candidate.id))) {
        if (onlyApprovals(run)) {
          track(run, await deps.runs.events(run.id), false)
          continue
        }
        const nodes = Object.fromEntries(
          Object.entries(run.nodes).map(([id, node]) => [id, node.status === 'running' ? { ...node, status: 'cancelled' as const, waiting: null } : node])
        )
        void deps.runs.save({ ...run, status: 'interrupted', nodes })
      }
    },
    dispose: (): void =>
      [...active.values()].forEach((entry) => {
        if (!onlyApprovals(entry.run)) return end(entry, 'interrupted', new Error('Interrupted'))
        entry.flush()
        active.delete(entry.run.id)
      })
  }
}
