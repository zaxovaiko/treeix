import { join } from 'node:path'
import { Notification } from 'electron'
import type { ChatOption, MainPlugin } from '@treeix/sdk/main'
import { isJson, isString } from '@treeix/shared/json'
import { cronMatches } from '../shared/cron'
import { type HubAgent, isHubAgent } from '../shared/types'
import { validate } from '../shared/validate'
import { type AgentRuntime, askWorkflow, isWorkflow, type Run, type Workflow } from '../shared/workflow'
import { createEngine } from './engine'
import { createKeys } from './keys'
import { hubTools } from './mcp'
import { createOpenAiAdapter } from './openaiAdapter'
import { createRuns } from './runs'
import { jsonList } from './store'

const DETECT_TIMEOUT_MS = 60_000
const MINUTE_MS = 60_000
const NOTICE_CHARS = 300

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
      runs: createRuns(join(context.dataPath, 'runs')),
      onRun: (run) => context.broadcast('run', run),
      onEvents: (runId, events) => context.broadcast('events', runId, events)
    })
    void engine.recover()
    context.onDispose(engine.dispose)

    context.handle('runs', () => engine.list())
    context.handle('runEvents', (_, id: string) => engine.events(id))
    context.handle('ask', (_, agent: string, message: string) => engine.ask(agent, message, null, false).id)
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
    const notify = (agent: HubAgent, run: Run): void => {
      if (!Notification.isSupported()) return
      const failed = run.status !== 'done'
      const notice = new Notification({
        title: failed ? `${agent.name}'s scheduled run ${run.status}` : agent.name,
        body: ((failed ? run.nodes.agent?.error : run.output) ?? '').slice(0, NOTICE_CHARS)
      })
      notices.add(notice)
      notice.on('click', () => (notices.delete(notice), context.broadcast('openRun', run.id)))
      notice.on('close', () => notices.delete(notice))
      notice.show()
    }

    // ponytail: schedules fire only while Treeix runs; a minute missed asleep or quit is skipped, not caught up
    const fireSchedules = async (now: Date): Promise<void> => {
      for (const agent of await agents.get())
        for (const schedule of agent.schedules ?? []) {
          if (!schedule.enabled || !schedule.prompt.trim() || !cronMatches(schedule.cron, now)) continue
          const run = engine.launch('schedule', schedule.prompt.trim().split('\n')[0], askWorkflow(agent.id, null), schedule.prompt)
          if (schedule.notify) void engine.wait(run.id).then((ended) => ended && notify(agent, ended))
        }
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

    context.on('cancelRun', (_, id: string) => engine.cancel(id))
    context.on('decide', (_, runId: string, node: string, approved: boolean) => engine.decide(runId, node, approved))
    context.handle('retryRun', (_, runId: string, node: string) => engine.retry(runId, node))
    context.on('answer', (_, runId: string, node: string, requestId: string, optionId: string | null) => engine.answer(runId, node, requestId, optionId))

    hubTools({ agents: agents.get, saveAgents: write, workflows: workflows.get, saveWorkflows: writeWorkflows, engine }).forEach((tool) => context.mcpTool(tool))
  }
}

export default plugin
