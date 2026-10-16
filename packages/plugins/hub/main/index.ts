import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, Notification, powerMonitor } from 'electron'
import type { ChatOption, MainPlugin } from '@treeix/sdk/main'
import { userShell } from '@treeix/host/env'
import { readJsonFile } from '@treeix/host/paths'
import { createSecrets } from '@treeix/host/secrets'
import { isJson, isString, list, text } from '@treeix/shared/json'
import { cronMatches } from '../shared/cron'
import { render } from '../shared/template'
import { commandItems, type HubAgent, isHubAgent, type Schedule, toDecisionSettings } from '../shared/types'
import { validate } from '../shared/validate'
import { type AgentNode, type AgentRuntime, askWorkflow, type Decider, isPullRequestCard, isWorkflow, onCard, type TicketDetail, type Workflow } from '../shared/workflow'
import { createAttention } from './attention'
import { createDecisions } from './decisions'
import { readSubagents } from './subagents'
import { createEngine } from './engine'
import { createKeys } from './keys'
import { hubTools } from './mcp'
import { createOpenAiAdapter } from './openaiAdapter'
import { ollamaHandlers } from './ollama'
import { createRemote, openAsks } from './remote'
import { createRuns } from './runs'
import { jsonList } from './store'
import { createWatches } from './watch'

const DETECT_TIMEOUT_MS = 60_000
const MINUTE_MS = 60_000
const NOTICE_CHARS = 300
const TITLE_CHARS = 80
const COMMAND_TIMEOUT_MS = 60_000
/** How often watches ask Jira and Notion what matches */
const WATCH_EVERY_MIN = 2
/** Idle this long at the Mac counts as away, even with Treeix in front */
const AWAY_S = 120

const exec = promisify(execFile)
const FROM_WEB: Decider = { by: 'you', via: 'web', reason: null }

const isAgentRuntime = (value: unknown): value is AgentRuntime =>
  isJson(value) && isString(value.agent) && isString(value.adapter) && isString(value.command) && isString(value.cwd)

const upsert = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((entry) => entry.id === item.id) ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]

/** A Jira work item or Notion page as the board's ticket dialog shows it */
function toTicket(source: unknown, raw: unknown): TicketDetail {
  const item = isJson(raw) ? raw : {}
  const comments = Array.isArray(item.comments) ? item.comments.filter(isJson) : []
  return {
    title: text(source === 'jira' ? item.summary : item.title),
    url: text(item.url) || null,
    body: text(source === 'jira' ? item.description : item.markdown),
    comments: comments.map((comment) => ({ author: text(comment.author), created: text(comment.created), body: text(comment.body) }))
  }
}

let keys: ReturnType<typeof createKeys> | null = null

const plugin: MainPlugin = {
  chatAdapters: [createOpenAiAdapter(async (baseUrl) => (await keys?.get(baseUrl)) ?? null)],
  activate: (context) => {
    const agents = jsonList(join(context.dataPath, 'agents.json'), isHubAgent)
    const apiKeys = createKeys(join(context.dataPath, 'keys.bin'))
    keys = apiKeys
    context.onDispose(() => (keys = null))

    const write = async (next: HubAgent[]): Promise<void> => {
      await agents.set(next)
      context.broadcast('agents', next)
    }

    context.handle('agents', () => agents.get())
    context.handle('saveAgent', async (_, agent: unknown) => {
      if (!isHubAgent(agent)) throw new Error('Invalid agent')
      await write(upsert(await agents.get(), agent))
    })
    context.handle('deleteAgent', async (_, id: string) => write((await agents.get()).filter((entry) => entry.id !== id)))

    // The renderer learns whether a key is saved, never the key
    context.handle('hasKey', async (_, baseUrl: string) => (await apiKeys.get(baseUrl)) !== null)
    context.handle('setKey', (_, baseUrl: string, key: string | null) => apiKeys.set(baseUrl, key))
    ollamaHandlers(context)

    /** The models and modes an agent offers, read from a throwaway session */
    context.handle('detect', async (_, adapterId: string, command: string, cwd: string): Promise<ChatOption[]> => {
      const adapter = context.chatAdapter(adapterId)
      if (!adapter) throw new Error(`No ${adapterId} adapter`)
      const connection = await adapter.connect({ cwd, command, env: {}, resume: null })
      let timer: ReturnType<typeof setTimeout> | undefined
      let unfollow = (): void => undefined
      try {
        return await new Promise<ChatOption[]>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('The agent sent no options')), DETECT_TIMEOUT_MS)
          // Options are state, so the first event a new listener gets
          unfollow = connection.onEvent((event) => event.type === 'options' && resolve(event.options))
        })
      } finally {
        clearTimeout(timer)
        unfollow()
        connection.close()
      }
    })

    // Agent runtimes resolve in the renderer's registry; main keeps the last list so runs work before a window syncs
    const runtimes = jsonList(join(context.dataPath, 'runtimes.json'), isAgentRuntime)
    context.handle('setRuntimes', (_, next: unknown) => runtimes.set(Array.isArray(next) ? next.filter(isAgentRuntime) : []))

    // The web app on the tailnet: what the phone can see and do, each call the same one a window's IPC makes
    const remote = createRemote({
      dataPath: context.dataPath,
      secrets: createSecrets(join(context.dataPath, 'remote.bin')),
      staticDir: join(__dirname, '../renderer'),
      onStatus: (status) => context.broadcast('remote', status),
      routes: {
        'GET agents': async () => (await agents.get()).map(({ id, name }) => ({ id, name })),
        'GET runs': () => engine.list(),
        'GET runs/:id/asks': async ({ id }) => openAsks(await engine.events(id)),
        'GET workflows': async () => (await workflows.get()).map(({ id, name }) => ({ id, name })),
        'POST workflows/:id/run': ({ id }, body) => startWorkflow(id, text(body.input)),
        'POST runs/:id/decide': ({ id }, body) => engine.decide(id, text(body.node), body.approved === true, FROM_WEB),
        'POST runs/:id/answer': ({ id }, body) => engine.answer(id, text(body.node), text(body.requestId), isString(body.optionId) ? body.optionId : null, FROM_WEB),
        'POST runs/:id/cancel': ({ id }) => engine.cancel(id),
        'POST runs/:id/resume': ({ id }) => engine.resume(id)
      }
    })
    context.onDispose(remote.dispose)
    context.handle('remote', () => remote.status())
    context.handle('setRemote', (_, on: unknown) => remote.setOn(on === true))
    context.handle('forgetDevices', () => remote.forgetDevices())
    context.handle('testPush', () => remote.notify({ title: 'Treeix', body: 'Notifications reach this device', url: '/' }))

    // Shown notifications are kept until clicked or closed, else Electron collects them and the click goes nowhere
    const notices = new Set<Notification>()
    const show = (title: string, body: string, runId: string | null): void => {
      if (!Notification.isSupported()) return
      const notice = new Notification({ title, body: body.slice(0, NOTICE_CHARS) })
      notices.add(notice)
      notice.on('click', () => (notices.delete(notice), runId && context.broadcast('openRun', runId)))
      notice.on('close', () => notices.delete(notice))
      notice.show()
    }
    // The phone hears what the Mac would show, when nobody sits at it
    const tell = (title: string, body: string, runId: string): void => {
      show(title, body, runId)
      void remote.notify({ title, body: body.slice(0, NOTICE_CHARS), url: `/#run=${runId}`, tag: runId })
    }
    const away = (): boolean => !BrowserWindow.getFocusedWindow() || powerMonitor.getSystemIdleTime() > AWAY_S
    // A failed run says so, since often nobody watched it start; a waiting or finished one only to someone away
    const attend = createAttention(
      ({ run, ...attention }) => {
        if (attention.kind === 'ended') {
          if (run.kind === 'ask') return
          if (run.status === 'failed') tell(`${run.title} failed`, Object.values(run.nodes).find((node) => node.error)?.error ?? '', run.id)
          else if (run.status === 'done' && away())
            void remote.notify({ title: `${run.title} is done`, body: (run.output ?? '').slice(0, NOTICE_CHARS), url: `/#run=${run.id}`, tag: run.id })
          return
        }
        if (!away()) return
        void decisions.ask(run, attention.node).catch((error: unknown) => console.error('[hub] Asking on the ticket failed', error))
        const node = run.nodes[attention.node]
        tell(`${run.title} needs you`, node.waiting === 'approval' ? (node.prompt ?? 'Approve to go on') : 'An agent asks for permission', run.id)
      },
      // Keep awake holds the Mac up while a run goes, waits included: a reply may come from another device
      (busy) => void context.emit('busy', { busy })
    )

    const engine = createEngine({
      adapter: context.chatAdapter,
      runtime: async (agent) => (await runtimes.get()).find((entry) => entry.agent === agent) ?? null,
      autoApprove: async (agent) => (await agents.get()).find((entry) => entry.id === agent)?.autoApprove === true,
      sessionEnv: context.sessionEnv,
      callTool: context.callTool,
      runs: createRuns(join(context.dataPath, 'runs')),
      onRun: (run) => (context.broadcast('run', run), remote.publish({ type: 'run', run }), attend(run), decisions.watch(run)),
      onEvents: (runId, events) => context.broadcast('events', runId, events)
    })
    // Who answers a waiting step when the user doesn't, and when
    const decisionsFile = join(context.dataPath, 'decisions.json')
    const decisionSettings = async () => toDecisionSettings(await readJsonFile(decisionsFile))
    context.handle('decisionSettings', decisionSettings)
    context.handle('setDecisionSettings', (_, next: unknown) => writeFile(decisionsFile, JSON.stringify(toDecisionSettings(next))))
    const decisions = createDecisions({ engine, settings: decisionSettings, callTool: context.callTool, notify: (run, title, body) => tell(title, body, run.id) })
    context.onDispose(decisions.dispose)
    // The setting lives here, not in the renderer's storage, so runs resume once at launch whatever windows open
    const autoResumeFile = join(context.dataPath, 'autoResume.json')
    context.handle('autoResume', async () => (await readJsonFile(autoResumeFile)) === true)
    context.handle('setAutoResume', (_, on: unknown) => writeFile(autoResumeFile, JSON.stringify(on === true)))
    // Quitting interrupts runs itself; recover() catches the ones a crash left running
    const atQuitFile = join(context.dataPath, 'interruptedAtQuit.json')
    void Promise.all([engine.recover(), readJsonFile(atQuitFile)]).then(async ([crashed, atQuit]) => {
      await rm(atQuitFile, { force: true })
      // Approvals wait on across a relaunch: they keep the Mac up and are told again
      for (const run of (await engine.list()).filter((candidate) => candidate.status === 'running')) {
        attend(run)
        decisions.watch(run)
      }
      if ((await readJsonFile(autoResumeFile)) !== true) return
      for (const id of [...crashed, ...list(atQuit, isString)]) await engine.resume(id).catch((error: unknown) => console.error('[hub] Resuming a run failed', error))
    })
    context.onDispose(() => writeFileSync(atQuitFile, JSON.stringify(engine.dispose())))

    context.handle('runs', () => engine.list())
    context.handle('runEvents', (_, id: string) => engine.events(id))
    context.handle('deleteRun', async (_, id: string) => {
      if (!(await engine.remove(id))) return
      context.broadcast('runRemoved', id)
      remote.publish({ type: 'removed', id })
    })
    context.handle('ask', (_, agent: string, message: string) => engine.ask(agent, message, null, false).id)
    context.handle('subagents', async (_, id: string) => {
      const agent = (await agents.get()).find((entry) => entry.id === id)
      return agent ? readSubagents([agent.folder, ...(agent.directories ?? [])].filter((folder): folder is string => folder !== null)) : []
    })
    const workflows = jsonList(join(context.dataPath, 'workflows.json'), isWorkflow)
    const writeWorkflows = async (next: Workflow[]): Promise<void> => {
      await workflows.set(next)
      context.broadcast('workflows', next)
    }
    context.handle('workflows', () => workflows.get())
    context.handle('saveWorkflow', async (_, workflow: unknown) => {
      if (!isWorkflow(workflow)) throw new Error('Invalid workflow')
      await writeWorkflows(upsert(await workflows.get(), workflow))
    })
    context.handle('deleteWorkflow', async (_, id: string) => writeWorkflows((await workflows.get()).filter((entry) => entry.id !== id)))
    const startWorkflow = async (id: string, input: string): Promise<string> => {
      const workflow = (await workflows.get()).find((entry) => entry.id === id)
      if (!workflow) throw new Error('The workflow is gone')
      const problem = validate(
        workflow,
        (await agents.get()).map((agent) => agent.id)
      )[0]
      if (problem) throw new Error(problem.message)
      return engine.launch('workflow', workflow.name, workflow, input).id
    }
    context.handle('runWorkflow', (_, id: string, input: string) => startWorkflow(id, input))
    // A pull request dropped on a board stage: one agent on it at a time, held from the first check so two quick drops can't both start
    const moving = new Set<string>()
    context.handle('moveCard', async (_, card: unknown, id: string) => {
      if (!isPullRequestCard(card)) throw new Error('Invalid pull request')
      if (moving.has(card.url)) throw new Error('An agent is already on this pull request')
      moving.add(card.url)
      try {
        const workflow = (await workflows.get()).find((entry) => entry.id === id)
        if (!workflow) throw new Error('The workflow is gone')
        const problem = validate(
          workflow,
          (await agents.get()).map((agent) => agent.id)
        )[0]
        if (problem) throw new Error(problem.message)
        if ((await engine.list()).some((run) => run.card === card.url && run.status === 'running')) throw new Error('An agent is already on this pull request')
        const title = `${workflow.name}: #${card.number} ${card.title}`.slice(0, TITLE_CHARS)
        return engine.launch('workflow', title, onCard(workflow, card), JSON.stringify(card), false, { card: card.url }).id
      } finally {
        moving.delete(card.url)
      }
    })

    const launchScheduled = (agent: HubAgent, schedule: Schedule, title: string, prompt: string): void => {
      const run = engine.launch('schedule', title, askWorkflow(agent.id, null, schedule.timeoutMin), prompt)
      if (schedule.notify) void engine.wait(run.id).then((ended) => ended?.status === 'done' && show(agent.name, ended.output ?? '', ended.id))
    }
    const launchWorkflow = async (workflow: Workflow, schedule: Schedule, title: string, input: string): Promise<void> => {
      const problem = validate(
        workflow,
        (await agents.get()).map((agent) => agent.id)
      )[0]
      if (problem) return show(`${workflow.name}'s schedule can't start it`, problem.message, null)
      const run = engine.launch('workflow', title, workflow, input)
      if (!schedule.notify) return
      const ended = await engine.wait(run.id)
      if (ended?.status === 'done') show(workflow.name, ended.output ?? '', ended.id)
    }
    /** Where a workflow's schedule command runs: its first agent step's folder */
    const workflowFolder = async (workflow: Workflow): Promise<string | null> => {
      const step = workflow.nodes.find((node): node is AgentNode => node.kind === 'agent')
      return step ? (step.folder ?? (await runtimes.get()).find((entry) => entry.agent === step.agent)?.cwd ?? null) : null
    }
    // A slow command is skipped on the next firing, never stacked
    const polling = new Set<string>()
    const runCommand = async (owner: string, schedule: Schedule, folder: string | null, start: (title: string, input: string) => void): Promise<void> => {
      if (polling.has(schedule.id)) return
      polling.add(schedule.id)
      try {
        // A login shell, so the command sees the user's PATH even when Treeix started from the Dock
        const { stdout } = await exec(userShell(), ['-lc', schedule.command ?? ''], { cwd: folder ?? homedir(), timeout: COMMAND_TIMEOUT_MS })
        for (const item of commandItems(stdout)) start(item.title, render(schedule.prompt, { input: item.input, prev: '', outputs: {} }))
      } catch (error) {
        show(`${owner}'s schedule command failed`, error instanceof Error ? error.message : String(error), null)
      } finally {
        polling.delete(schedule.id)
      }
    }
    const fire = (owner: string, schedule: Schedule, folder: () => Promise<string | null>, start: (title: string, input: string) => void): void => {
      if (schedule.command?.trim()) void folder().then((cwd) => runCommand(owner, schedule, cwd, start))
      else start(schedule.prompt.trim().split('\n')[0], schedule.prompt)
    }

    // ponytail: schedules fire only while Treeix runs; a minute missed asleep or quit is skipped, not caught up
    const fireSchedules = async (now: Date): Promise<void> => {
      const due = (schedule: Schedule): boolean => schedule.enabled && schedule.prompt.trim() !== '' && cronMatches(schedule.cron, now)
      for (const agent of await agents.get())
        for (const schedule of (agent.schedules ?? []).filter(due))
          fire(
            agent.name,
            schedule,
            async () => agent.folder,
            (title, prompt) => launchScheduled(agent, schedule, title, prompt)
          )
      for (const workflow of await workflows.get())
        for (const node of workflow.nodes)
          for (const schedule of node.kind === 'input' ? (node.schedules ?? []).filter(due) : [])
            fire(
              workflow.name,
              schedule,
              () => workflowFolder(workflow),
              (title, input) => void launchWorkflow(workflow, schedule, title, input)
            )
    }
    // A watched item starts its own run
    const checkWatches = createWatches({
      file: join(context.dataPath, 'watches.json'),
      workflows: workflows.get,
      runs: engine.list,
      callTool: context.callTool,
      launch: async (workflow, item) => {
        const problem = validate(
          workflow,
          (await agents.get()).map((agent) => agent.id)
        )[0]
        if (problem) throw new Error(problem.message)
        const title = `${workflow.name}: ${item.key} ${item.title}`.trim().slice(0, TITLE_CHARS)
        engine.launch('workflow', title, workflow, JSON.stringify(item), false, { ticket: { key: item.key, url: item.url } })
      },
      failed: (workflow, message) => show(`${workflow.name} can't check its watch`, message, null)
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    // Re-aimed at each minute's start, so the clock never drifts past one
    const tick = (): void => {
      timer = setTimeout(
        () => {
          const now = new Date()
          void fireSchedules(now)
          if (now.getMinutes() % WATCH_EVERY_MIN === 0) void checkWatches().then(decisions.poll)
          tick()
        },
        MINUTE_MS - (Date.now() % MINUTE_MS)
      )
    }
    tick()
    context.onDispose(() => clearTimeout(timer))

    // A workflow whose input lists an event starts on it
    context.onEvent(async (name, payload) => {
      const triggered = (await workflows.get()).filter((workflow) => workflow.nodes.some((node) => node.kind === 'input' && node.events?.includes(name)))
      const ids = (await agents.get()).map((agent) => agent.id)
      let started = false
      for (const workflow of triggered) {
        const problem = validate(workflow, ids)[0]
        if (problem) {
          show(`${workflow.name} can't start on ${name}`, problem.message, null)
          continue
        }
        const title = isString(payload.title) && payload.title.trim() ? `${workflow.name}: ${payload.title.trim()}`.slice(0, TITLE_CHARS) : workflow.name
        engine.launch('workflow', title, workflow, JSON.stringify(payload))
        started = true
      }
      return started
    })

    // A run's Jira work item or Notion page, through their plugins' tools, so the board can show, edit and comment on it
    const ticketTool = (source: unknown, action: 'read' | 'edit' | 'comment'): string => {
      if (source !== 'jira' && source !== 'notion') throw new Error('Unknown ticket source')
      return { jira: { read: 'jira_work_item', edit: 'jira_edit', comment: 'jira_comment' }, notion: { read: 'notion_page', edit: 'notion_edit_page', comment: 'notion_comment' } }[
        source
      ][action]
    }
    const ticketArgs = (source: unknown, key: string): Record<string, string> => (source === 'jira' ? { key } : { page: key })
    context.handle('ticket', async (_, source: unknown, key: string) => toTicket(source, JSON.parse(await context.callTool(ticketTool(source, 'read'), ticketArgs(source, key)))))
    context.handle('editTicket', (_, source: unknown, key: string, changes: { title?: string; body?: string }) =>
      context.callTool(ticketTool(source, 'edit'), {
        ...ticketArgs(source, key),
        ...(source === 'jira' ? { summary: changes.title, description: changes.body } : { title: changes.title, markdown: changes.body })
      })
    )
    context.handle('commentTicket', (_, source: unknown, key: string, body: string) => context.callTool(ticketTool(source, 'comment'), { ...ticketArgs(source, key), body }))

    context.on('cancelRun', (_, id: string) => engine.cancel(id))
    context.on('decide', (_, runId: string, node: string, approved: boolean) => engine.decide(runId, node, approved))
    context.handle('retryRun', (_, runId: string, node: string) => engine.retry(runId, node))
    context.handle('resumeRun', (_, runId: string) => engine.resume(runId))
    context.on('answer', (_, runId: string, node: string, requestId: string, optionId: string | null) => engine.answer(runId, node, requestId, optionId))

    hubTools({ agents: agents.get, saveAgents: write, workflows: workflows.get, saveWorkflows: writeWorkflows, engine }).forEach((tool) => context.mcpTool(tool))
  }
}

export default plugin
