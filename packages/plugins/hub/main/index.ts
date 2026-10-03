import { join } from 'node:path'
import type { ChatOption, MainPlugin } from '@treeix/sdk/main'
import { isJson, isString } from '@treeix/shared/json'
import { type HubAgent, isHubAgent } from '../shared/types'
import type { AgentRuntime } from '../shared/workflow'
import { createEngine } from './engine'
import { createKeys } from './keys'
import { createOpenAiAdapter } from './openaiAdapter'
import { createRuns } from './runs'
import { jsonList } from './store'

const DETECT_TIMEOUT_MS = 60_000

const isAgentRuntime = (value: unknown): value is AgentRuntime => isJson(value) && isString(value.agent) && isString(value.adapter) && isString(value.command) && isString(value.cwd)

const argument = (args: Record<string, unknown>, name: string): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
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
      const current = await agents.get()
      await write(current.some((entry) => entry.id === agent.id) ? current.map((entry) => (entry.id === agent.id ? agent : entry)) : [...current, agent])
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
    context.on('cancelRun', (_, id: string) => engine.cancel(id))
    context.on('answer', (_, runId: string, node: string, requestId: string, optionId: string | null) => engine.answer(runId, node, requestId, optionId))

    context.mcpTool({
      name: 'hub_agents',
      description: "Lists the user's AI Hub agents, which hub_ask can ask: each one's name and instructions.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => (await agents.get()).map((agent) => `${agent.name}: ${agent.instructions.trim() || '(no instructions)'}`).join('\n\n') || 'No agents yet; the user creates them in the AI Hub tab'
    })
    context.mcpTool({
      name: 'hub_ask',
      description:
        'Asks one of the AI Hub agents (see hub_agents) and waits for its answer, up to 10 minutes. Each ask is a fresh conversation, so include everything the agent needs to know. The user sees the run in the AI Hub tab.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent name' },
          message: { type: 'string' },
          folder: { type: 'string', description: "Absolute path the agent works in; its own folder by default" }
        },
        required: ['agent', 'message'],
        additionalProperties: false
      },
      run: async (args) => {
        const name = argument(args, 'agent').trim().toLowerCase()
        const agent = (await agents.get()).find((candidate) => candidate.name.toLowerCase() === name || candidate.id === name)
        if (!agent) throw new Error(`No agent named ${args.agent}; hub_agents lists them`)
        const run = await engine.wait(engine.ask(agent.id, argument(args, 'message'), typeof args.folder === 'string' && args.folder ? args.folder : null, true).id)
        if (run?.status !== 'done') throw new Error(run?.nodes.agent.error ?? `The run ended ${run?.status ?? 'unexpectedly'}`)
        return run.output || '(no answer)'
      }
    })
  }
}

export default plugin
