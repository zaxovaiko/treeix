import { isJson, list, text } from '@treeix/shared/json'
import type { DecisionSettings } from '../shared/types'
import { type AgentNode, type Decider, type JudgeNode, type Decision, decisionText, type Run, ticketOf, type TicketSource } from '../shared/workflow'
import type { createEngine } from './engine'

type Engine = Pick<ReturnType<typeof createEngine>, 'ask' | 'wait' | 'decide' | 'answer' | 'questions' | 'events'>
type Ticket = { source: TicketSource; key: string }
type Comment = { created: string; body: string }
export type Reply = { approved: boolean; reason: string | null }

const MINUTE_MS = 60_000
/** setTimeout's longest delay; a later deadline is re-armed when this one fires */
const MAX_DELAY_MS = 2 ** 31 - 1
const ASK = 'Treeix needs a decision'
const REPLY = /^[\s*_]*(approve|reject)(?:e?d)?\b[\s*_.,:;!-]*([\s\S]*)$/i
const VERDICT = /\{[\s\S]*\}/

/** Tags every comment Treeix posts about a waiting step, so the replies under it can be told from it */
export const marker = (runId: string, node: string): string => `[treeix:${runId}:${node}]`

/**
 * Where the ticket stands on the step: `asked` while Treeix's latest comment about it is a question, with the first later
 * comment that isn't Treeix's own and opens with approve or reject as the reply. Comments are told apart by the marker, not
 * the author, since Treeix posts as the user.
 */
export function ticketThread(comments: Comment[], tag: string): { asked: false } | { asked: true; reply: Reply | null } {
  const sorted = [...comments].sort((a, b) => (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0))
  const last = sorted.findLastIndex((comment) => comment.body.includes(tag))
  if (last < 0 || !sorted[last].body.includes(ASK)) return { asked: false }
  for (const comment of sorted.slice(last + 1)) {
    const [, word, rest] = comment.body.includes('[treeix:') ? [] : (REPLY.exec(comment.body.trim()) ?? [])
    if (word) return { asked: true, reply: { approved: word.toLowerCase().startsWith('approve'), reason: rest.trim() || null } }
  }
  return { asked: true, reply: null }
}

/** The agent's verdict from its reply; anything else rejects, since a run should not go on unchecked */
export function parseVerdict(reply: string): Reply {
  try {
    const verdict: unknown = JSON.parse(VERDICT.exec(reply)?.[0] ?? '')
    if (isJson(verdict) && typeof verdict.approve === 'boolean') return { approved: verdict.approve, reason: text(verdict.reason) || null }
  } catch {
    // Not JSON: rejected below
  }
  return { approved: false, reason: `The agent's answer was not a decision: ${reply.slice(0, 200)}` }
}

/** Who decides for a step: the hub's pick, else the step's own agent, the agent feeding it, or the workflow's first */
export function deciderOf(run: Run, node: string, picked: string | null): string | null {
  if (picked) return picked
  const agents = run.workflow.nodes.filter((step): step is AgentNode | JudgeNode => step.kind === 'agent' || step.kind === 'judge')
  return (
    agents.find((step) => step.id === node)?.agent ??
    agents.find((step) => run.workflow.edges.some((edge) => edge.from === step.id && edge.to === node))?.agent ??
    agents[0]?.agent ??
    null
  )
}

/**
 * Gets waiting steps answered while the user is away: asks on the run's ticket and takes the reply from there, and once a
 * step has waited past its deadline, has an agent decide. Every decision not made at the Mac is told back to the ticket and the phone.
 */
export function createDecisions(deps: {
  engine: Engine
  settings: () => Promise<DecisionSettings>
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  notify: (run: Run, title: string, body: string) => void
}) {
  const { engine } = deps
  const started = Date.now()
  /** Waiting steps by `<run>:<node>`, with their deadline timer once armed */
  const timers = new Map<string, ReturnType<typeof setTimeout> | null>()
  const latest = new Map<string, Run>()
  /** Runs of agents deciding, which never get a decider of their own */
  const deciders = new Set<string>()
  const told = new Set<string>()
  let polling = false

  const comments = async (ticket: Ticket): Promise<Comment[]> => {
    const toComment = (entry: Record<string, unknown>): Comment => ({ created: text(entry.created ?? entry.created_time), body: text(entry.body) })
    if (ticket.source === 'notion') return list(JSON.parse(await deps.callTool('notion_comments', { page: ticket.key }))).map(toComment)
    const item: unknown = JSON.parse(await deps.callTool('jira_work_item', { key: ticket.key }))
    return list(isJson(item) ? item.comments : [])
      .flatMap((entry) => [entry, ...list(entry.replies)])
      .map(toComment)
  }
  const comment = (ticket: Ticket, body: string): Promise<string> =>
    deps.callTool(ticket.source === 'jira' ? 'jira_comment' : 'notion_comment', { ...(ticket.source === 'jira' ? { key: ticket.key } : { page: ticket.key }), body })
  /** The run's ticket, when asking there is on */
  const ticketFor = async (run: Run): Promise<Ticket | null> => ((await deps.settings()).ticket && !deciders.has(run.id) ? ticketOf(run) : null)

  const minutesFor = async (run: Run, node: string): Promise<number | null> => {
    const step = run.workflow.nodes.find((candidate) => candidate.id === node)
    const own = step?.kind === 'approval' ? step.timeoutMin : null
    return own && own > 0 ? own : (await deps.settings()).afterMin
  }

  const question = (run: Run, node: string): string => {
    const state = run.nodes[node]
    if (state.waiting === 'approval') return state.prompt || 'Go on?'
    const asked = engine.questions(run.id).find((candidate) => candidate.node === node)
    return `An agent asks for permission: ${asked?.title ?? 'a tool call'}`
  }

  /** Approves or rejects what the step waits on now; a no-op once someone else answered */
  const apply = (run: Run, node: string, approved: boolean, who: Decider): void => {
    if (run.nodes[node]?.waiting === 'approval') return engine.decide(run.id, node, approved, who)
    const asked = engine.questions(run.id).find((candidate) => candidate.node === node)
    if (!asked) return
    const pick =
      asked.options.find((option) => option.kind === (approved ? 'allow_once' : 'reject_once')) ??
      asked.options.find((option) => option.kind.startsWith(approved ? 'allow' : 'reject'))
    engine.answer(run.id, node, asked.requestId, pick?.id ?? null, who)
  }

  /** What the agent judges by: for an approval what came in, for a permission the step's task and the call's input */
  const context = async (run: Run, node: string): Promise<string> => {
    if (run.nodes[node].waiting === 'approval')
      return run.workflow.edges
        .filter((edge) => edge.to === node)
        .map((edge) => run.nodes[edge.from]?.output ?? '')
        .filter(Boolean)
        .join('\n\n')
    const asked = engine.questions(run.id).find((candidate) => candidate.node === node)
    const call = (await engine.events(run.id)).findLast(({ event }) => event.type === 'tool_call' && event.call.id === asked?.toolCallId)?.event
    const input = call?.type === 'tool_call' ? JSON.stringify(call.call.rawInput) : ''
    return [`The step's task:\n${run.nodes[node].prompt ?? ''}`, input && `The call's input:\n${input}`].filter(Boolean).join('\n\n')
  }

  async function decideAlone(run: Run, node: string, minutes: number): Promise<void> {
    const agent = deciderOf(run, node, (await deps.settings()).agent)
    if (!agent) return deps.notify(run, `${run.title} still waits for you`, 'No agent can decide in your place; pick one in Settings, Agents.')
    const prompt = [
      `Decide for ${run.title}: ${question(run, node)}`,
      `You decide in place of the user, who did not answer within ${minutes} min. Change nothing; only read what you need to judge.`,
      await context(run, node),
      'Approve only when it is clearly safe and what the task asked for; when unsure, reject.',
      'Reply with only a JSON object: {"approve": true or false, "reason": "one or two sentences the user will read"}'
    ].join('\n\n')
    const ask = engine.ask(agent, prompt, null, true)
    deciders.add(ask.id)
    const ended = await engine.wait(ask.id)
    deciders.delete(ask.id)
    if (ended?.status !== 'done')
      return deps.notify(
        run,
        `${run.title} still waits for you`,
        `The agent couldn't decide: ${Object.values(ended?.nodes ?? {}).find((step) => step.error)?.error ?? ended?.status ?? 'gone'}`
      )
    const verdict = parseVerdict(ended.output ?? '')
    apply(latest.get(run.id) ?? run, node, verdict.approved, { by: 'agent', via: 'app', reason: verdict.reason })
  }

  /** Arms the step's deadline, counted from when the approval started or the permission was first seen */
  function arm(run: Run, node: string, key: string): void {
    const due = (run.nodes[node].waiting === 'approval' ? run.nodes[node].startedAt : null) ?? Date.now()
    const fire = async (): Promise<void> => {
      const now = latest.get(run.id)
      const minutes = now && (await minutesFor(now, node))
      if (!now?.nodes[node]?.waiting || !minutes || !timers.has(key)) return
      if (Date.now() < due + minutes * MINUTE_MS)
        return void timers.set(
          key,
          setTimeout(() => void fire(), Math.min(MAX_DELAY_MS, due + minutes * MINUTE_MS - Date.now()))
        )
      await decideAlone(now, node, minutes).catch((error: unknown) => console.error('[hub] Deciding failed', error))
    }
    timers.set(key, null)
    void fire()
  }

  /** Tells the ticket and the phone what was decided away from the Mac */
  async function tell(run: Run, node: string, decision: Decision): Promise<void> {
    const said = decisionText(decision)
    if (decision.by === 'agent' || decision.via !== 'app') deps.notify(run, `${run.title}: ${decision.approved ? 'approved' : 'rejected'}`, said)
    const ticket = await ticketFor(run)
    const tag = marker(run.id, node)
    if (ticket && ticketThread(await comments(ticket), tag).asked) await comment(ticket, `Treeix decision ${tag}: ${said}.`)
  }

  return {
    /** Follows every saved run: arms deadlines for steps that start waiting, drops them once answered, tells new decisions */
    watch: (run: Run): void => {
      if (run.status === 'running') latest.set(run.id, run)
      else latest.delete(run.id)
      for (const [node, state] of Object.entries(run.nodes)) {
        const key = `${run.id}:${node}`
        const waiting = run.status === 'running' && Boolean(state.waiting) && !deciders.has(run.id)
        if (waiting && !timers.has(key)) arm(run, node, key)
        if (!waiting && timers.has(key)) {
          clearTimeout(timers.get(key) ?? undefined)
          timers.delete(key)
        }
        const decision = state.decision
        if (decision && decision.at >= started && !told.has(`${key}:${decision.at}`)) {
          told.add(`${key}:${decision.at}`)
          void tell(run, node, decision).catch((error: unknown) => console.error('[hub] Telling a decision failed', error))
        }
      }
    },
    /** Asks on the run's ticket, unless it already did, as before a relaunch */
    ask: async (run: Run, node: string): Promise<void> => {
      const ticket = await ticketFor(run)
      const tag = marker(run.id, node)
      if (!ticket || ticketThread(await comments(ticket), tag).asked) return
      const minutes = await minutesFor(run, node)
      const deadline = minutes ? ` Without a reply within ${minutes} min, an agent decides.` : ''
      await comment(ticket, `${ASK} ${tag} on ${run.title}: ${question(run, node)}\n\nReply "approve" or "reject <why>".${deadline}`)
    },
    /** Takes replies from the tickets of waiting runs; a slow check is skipped on the next tick, never stacked */
    poll: async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        for (const run of [...latest.values()]) {
          const ticket = await ticketFor(run)
          if (!ticket) continue
          for (const node of Object.keys(run.nodes).filter((id) => run.nodes[id].waiting)) {
            const thread = await comments(ticket).then((found) => ticketThread(found, marker(run.id, node)))
            if (thread.asked && thread.reply) apply(latest.get(run.id) ?? run, node, thread.reply.approved, { by: 'you', via: ticket.source, reason: thread.reply.reason })
          }
        }
      } catch (error) {
        console.error('[hub] Reading ticket replies failed', error)
      } finally {
        polling = false
      }
    },
    dispose: (): void => {
      timers.forEach((timer) => clearTimeout(timer ?? undefined))
      timers.clear()
    }
  }
}
