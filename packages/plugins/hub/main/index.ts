import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Notification } from 'electron'
import type { ChatOption, MainPlugin } from '@treeix/sdk/main'
import { userShell } from '@treeix/host/env'
import { isJson, isString } from '@treeix/shared/json'
import { cronMatches } from '../shared/cron'
import { render } from '../shared/template'
import { commandItems, type HubAgent, isHubAgent, isTicketRun, type Schedule, type TicketRun } from '../shared/types'
import { validate } from '../shared/validate'
import { type AgentNode, type AgentRuntime, askWorkflow, isWorkflow, type Run, type Workflow } from '../shared/workflow'
import { readSubagents } from './subagents'
import { createEngine } from './engine'
import { createKeys } from './keys'
import { hubTools } from './mcp'
import { createOpenAiAdapter } from './openaiAdapter'
import { ollamaHandlers } from './ollama'
import { createRuns } from './runs'
import { jsonList } from './store'

const DETECT_TIMEOUT_MS = 60_000
const MINUTE_MS = 60_000
const NOTICE_CHARS = 300
const TITLE_CHARS = 80
const COMMAND_TIMEOUT_MS = 60_000

const exec = promisify(execFile)

/** Where the launchd ticket runner keeps a JSON file per item; absent for anyone without it */
const TICKET_RUNS = join(homedir(), '.claude', 'ticket-runner', 'runs')
const TICKET_RUNS_DEBOUNCE_MS = 200

async function readTicketRuns(): Promise<TicketRun[]> {
  const names = await readdir(TICKET_RUNS).catch((): string[] => [])
  const runs = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        readFile(join(TICKET_RUNS, name), 'utf8')
          .then((text): unknown => JSON.parse(text))
          .catch(() => null)
      )
  )
  return runs.filter(isTicketRun)
}

const isAgentRuntime = (value: unknown): value is AgentRuntime =>
  isJson(value) && isString(value.agent) && isString(value.adapter) && isString(value.command) && isString(value.cwd)

const upsert = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((entry) => entry.id === item.id) ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]

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

    const engine = createEngine({
      adapter: context.chatAdapter,
      runtime: async (agent) => (await runtimes.get()).find((entry) => entry.agent === agent) ?? null,
      autoApprove: async (agent) => (await agents.get()).find((entry) => entry.id === agent)?.autoApprove === true,
      sessionEnv: context.sessionEnv,
      callTool: context.callTool,
      runs: createRuns(join(context.dataPath, 'runs')),
      onRun: (run) => context.broadcast('run', run),
      onEvents: (runId, events) => context.broadcast('events', runId, events)
    })
    void engine.recover()
    context.onDispose(engine.dispose)

    context.handle('runs', () => engine.list())
    context.handle('ticketRuns', readTicketRuns)
    let ticketTimer: ReturnType<typeof setTimeout> | undefined
    try {
      // ponytail: a runner installed after launch shows up on the next one
      const watcher = watch(TICKET_RUNS, { persistent: false }, () => {
        clearTimeout(ticketTimer)
        ticketTimer = setTimeout(() => void readTicketRuns().then((runs) => context.broadcast('ticketRuns', runs)), TICKET_RUNS_DEBOUNCE_MS)
      }).on('error', () => undefined)
      context.onDispose(() => (clearTimeout(ticketTimer), watcher.close()))
    } catch {
      // No runner on this Mac
    }
    context.handle('runEvents', (_, id: string) => engine.events(id))
    context.handle('deleteRun', async (_, id: string) => (await engine.remove(id)) && context.broadcast('runRemoved', id))
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
    context.handle('runWorkflow', async (_, id: string, input: string) => {
      const workflow = (await workflows.get()).find((entry) => entry.id === id)
      if (!workflow) throw new Error('The workflow is gone')
      const problem = validate(
        workflow,
        (await agents.get()).map((agent) => agent.id)
      )[0]
      if (problem) throw new Error(problem.message)
      return engine.launch('workflow', workflow.name, workflow, input).id
    })

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
    const notify = (agent: HubAgent, run: Run): void => {
      const failed = run.status !== 'done'
      show(failed ? `${agent.name}'s scheduled run ${run.status}` : agent.name, (failed ? run.nodes.agent?.error : run.output) ?? '', run.id)
    }

    const launchScheduled = (agent: HubAgent, schedule: Schedule, title: string, prompt: string): void => {
      const run = engine.launch('schedule', title, askWorkflow(agent.id, null, schedule.timeoutMin), prompt)
      if (schedule.notify) void engine.wait(run.id).then((ended) => ended && notify(agent, ended))
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
      if (!ended) return
      const failed = ended.status !== 'done'
      const error = Object.values(ended.nodes).find((node) => node.error)?.error
      show(failed ? `${workflow.name} ${ended.status}` : workflow.name, (failed ? error : ended.output) ?? '', ended.id)
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
    let timer: ReturnType<typeof setTimeout> | undefined
    // Re-aimed at each minute's start, so the clock never drifts past one
    const tick = (): void => {
      timer = setTimeout(
        () => {
          void fireSchedules(new Date())
          tick()
        },
        MINUTE_MS - (Date.now() % MINUTE_MS)
      )
    }
    tick()
    context.onDispose(() => clearTimeout(timer))

    // A workflow whose input lists an event starts on it; a failed run says so, since nobody watched it start
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
        const run = engine.launch('workflow', title, workflow, JSON.stringify(payload))
        started = true
        void engine.wait(run.id).then((ended) => {
          if (!ended || ended.status === 'done') return
          show(`${workflow.name} ${ended.status}`, Object.values(ended.nodes).find((node) => node.error)?.error ?? '', ended.id)
        })
      }
      return started
    })

    context.on('cancelRun', (_, id: string) => engine.cancel(id))
    context.on('decide', (_, runId: string, node: string, approved: boolean) => engine.decide(runId, node, approved))
    context.handle('retryRun', (_, runId: string, node: string) => engine.retry(runId, node))
    context.handle('resumeRun', (_, runId: string) => engine.resume(runId))
    context.on('answer', (_, runId: string, node: string, requestId: string, optionId: string | null) => engine.answer(runId, node, requestId, optionId))

    hubTools({ agents: agents.get, saveAgents: write, workflows: workflows.get, saveWorkflows: writeWorkflows, engine }).forEach((tool) => context.mcpTool(tool))
  }
}

export default plugin
