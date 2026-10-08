import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type McpServer, type RequestPermissionResponse, type Stream } from '@agentclientprotocol/sdk'
import type { ChatAdapter, ChatConnection, ChatEvent, ChatOption, ChatSpec } from '@treeix/sdk/main'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { fromPermissionRequest, fromSessionUpdate, optionsFrom, toPromptBlocks } from './acpEvents'
import { killGroup, spawnInShell } from './shell'

const STDERR_LIMIT = 4096
const BACKLOG_LIMIT = 5000
const CONNECT_TIMEOUT_MS = 30_000
/** Agents that add `_meta.systemPrompt.append` to their system prompt; others get instructions before the first message */
const SYSTEM_PROMPT_AGENTS = new Set(['@agentclientprotocol/claude-agent-acp'])

const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code
const RESOURCE_NOT_FOUND = -32002
const isResourceNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === RESOURCE_NOT_FOUND

/** Where a write to `target` lands: the file's real path, or, for a new file, its real folder plus its name */
async function realWriteTarget(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  // A dangling symlink would be followed by the write to wherever it points
  const link = await lstat(target).catch(() => null)
  if (link) throw new Error('Outside the session folder')
  return join(await realpath(dirname(target)), basename(target))
}

/** The agent may only touch files inside the session's folder, symlinks resolved */
export async function confinedPath(path: string, root: string, mode: 'read' | 'write'): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Path must be absolute')
  const realRoot = await realpath(root)
  const target = resolve(path)
  const real = mode === 'read' ? await realpath(target) : await realWriteTarget(target)
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  if (real !== realRoot && !real.startsWith(prefix)) throw new Error('Outside the session folder')
  return real
}

/** ACP `fs/read_text_file` slicing: `line` is 1-based, `limit` counts lines */
export function sliceLines(content: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line == null && limit == null) return content
  const start = Math.max((line ?? 1) - 1, 0)
  return content
    .split('\n')
    .slice(start, limit == null ? undefined : start + limit)
    .join('\n')
}

/** Treeix's own MCP server, from the session environment */
type TreeixMcp = { url: string; token: string }
type ConnectOptions = Pick<ChatSpec, 'instructions' | 'preset' | 'directories'> & {
  cwd: string
  resume: string | null
  close: () => void
  stderrTail?: () => string
  mcp?: TreeixMcp | null
}

export async function connectOverStream(
  stream: Stream,
  { cwd, resume, instructions, preset, directories, close, stderrTail = () => '', mcp = null }: ConnectOptions
): Promise<ChatConnection> {
  const listeners = new Set<(event: ChatEvent) => void>()
  // Events before the first listener (a loaded session's replay) wait for it, newest kept; options are state and sent on subscribe
  let backlog: ChatEvent[] | null = []
  const emit = (event: ChatEvent) => {
    if (event.type === 'options') options = event.options
    if (!backlog) for (const listener of listeners) listener(event)
    else if (event.type !== 'options') {
      backlog.push(event)
      if (backlog.length > BACKLOG_LIMIT) backlog.shift()
    }
  }

  let options: ChatOption[] = []
  const pending = new Map<string, (response: RequestPermissionResponse) => void>()
  let nextRequestId = 0

  const settle = (requestId: string, optionId: string | null) => {
    const respond = pending.get(requestId)
    if (!respond) return
    pending.delete(requestId)
    respond({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } })
    emit({ type: 'permission_settled', requestId })
  }
  const settleAll = () => {
    for (const requestId of pending.keys()) settle(requestId, null)
  }

  const withCurrentValue = (id: string, value: string) => options.map((option) => (option.id === id ? { ...option, currentValue: value } : option))

  const client: Client = {
    sessionUpdate: ({ update }) => {
      if (update.sessionUpdate === 'current_mode_update') {
        emit({ type: 'options', options: withCurrentValue('mode', update.currentModeId) })
        return
      }
      for (const event of fromSessionUpdate(update)) emit(event)
    },
    requestPermission: (params) =>
      new Promise((respond) => {
        const requestId = String(nextRequestId++)
        const event = fromPermissionRequest(requestId, params)
        if (!event) return respond({ outcome: { outcome: 'cancelled' } })
        pending.set(requestId, respond)
        emit(event)
      }),
    readTextFile: async ({ path, line, limit }) => ({ content: sliceLines(await readFile(await confinedPath(path, cwd, 'read'), 'utf8'), line, limit) }),
    writeTextFile: async ({ path, content }) => {
      // New files open exclusively, so a symlink planted after the check is not followed; an existing file is checked again
      await writeFile(await confinedPath(path, cwd, 'write'), content, { encoding: 'utf8', flag: 'wx' }).catch(async (error: unknown) => {
        if (!hasCode(error, 'EEXIST')) throw error
        await writeFile(await confinedPath(path, cwd, 'write'), content, 'utf8')
      })
      return {}
    }
  }

  const connection = new ClientSideConnection(() => client, stream)
  let closing = false
  // The agent went away: no permission card may keep waiting on it
  connection.signal.addEventListener('abort', () => {
    settleAll()
    if (closing) return
    const tail = stderrTail().trim()
    emit({ type: 'disconnected', message: tail ? `The agent stopped: ${tail}` : 'The agent stopped' })
  })
  const { agentCapabilities, agentInfo } = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    // subagent-transcript: claude-agent-acp streams subagents' text too, stamped with their parent call
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, _meta: { 'subagent-transcript': true } }
  })
  const takesSystemPrompt = SYSTEM_PROMPT_AGENTS.has(agentInfo?.name ?? '')
  const mcpServers: McpServer[] =
    mcp && agentCapabilities?.mcpCapabilities?.http ? [{ type: 'http', name: 'treeix', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }] : []
  const canLoad = agentCapabilities?.loadSession === true
  const canList = Boolean(agentCapabilities?.sessionCapabilities?.list)
  const additionalDirectories = directories?.length && agentCapabilities?.sessionCapabilities?.additionalDirectories ? directories : undefined

  const newSession = () =>
    connection
      .newSession({ cwd, mcpServers, additionalDirectories, _meta: instructions && takesSystemPrompt ? { systemPrompt: { append: instructions } } : undefined })
      .then((session) => ({ sessionId: session.sessionId, session }))
  // A conversation the agent no longer has (its transcript deleted, another machine) starts over instead of failing every retry
  const { sessionId, session } =
    resume && canLoad
      ? await connection.loadSession({ sessionId: resume, cwd, mcpServers, additionalDirectories }).then(
          (session) => ({ sessionId: resume, session }),
          (error: unknown) => (isResourceNotFound(error) ? newSession() : Promise.reject(error))
        )
      : await newSession()
  const hasConfigOptions = Boolean(session?.configOptions?.length)
  emit({ type: 'options', options: optionsFrom(session) })

  const setOption = async (id: string, value: string): Promise<void> => {
    if (hasConfigOptions) {
      const response = await connection.setSessionConfigOption({ sessionId, configId: id, value })
      emit({ type: 'options', options: optionsFrom(response) })
      return
    }
    if (id !== 'mode') return
    await connection.setSessionMode({ sessionId, modeId: value })
    emit({ type: 'options', options: withCurrentValue(id, value) })
  }

  // A resumed conversation already has its instructions, model and mode
  let preamble = instructions && !resume && !takesSystemPrompt ? instructions : null
  if (!resume) {
    for (const category of ['model', 'mode'] as const) {
      const value = preset?.[category]
      if (!value) continue
      const option = options.find((candidate) => candidate.category === category)
      if (!option?.values.some((candidate) => candidate.value === value)) {
        emit({ type: 'error', message: `This agent offers no ${category} "${value}"; using its default` })
        continue
      }
      if (option.currentValue === value) continue
      await setOption(option.id, value).catch((error: unknown) =>
        emit({ type: 'error', message: `Could not set the ${category}: ${error instanceof Error ? error.message : String(error)}` })
      )
    }
  }

  return {
    sessionId,
    capabilities: { images: agentCapabilities?.promptCapabilities?.image === true, load: canLoad, list: canList },
    onEvent: (listener) => {
      listeners.add(listener)
      const queued = backlog
      backlog = null
      if (queued) {
        listener({ type: 'options', options })
        for (const event of queued) listener(event)
      }
      return () => listeners.delete(listener)
    },
    prompt: async (content) => {
      emit({ type: 'turn_start' })
      const blocks = toPromptBlocks(preamble ? [{ type: 'text', text: preamble }, ...content] : content)
      preamble = null
      try {
        const { stopReason } = await connection.prompt({ sessionId, prompt: blocks })
        emit({ type: 'turn_end', stopReason })
        return { stopReason }
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        emit({ type: 'turn_end', stopReason: 'cancelled' })
        return { stopReason: 'cancelled' }
      }
    },
    cancel: () => {
      void connection.cancel({ sessionId }).catch(() => undefined)
      settleAll()
    },
    answer: settle,
    setOption,
    list: canList
      ? async (folder) => {
          const { sessions } = await connection.listSessions({ cwd: folder })
          return sessions.map((info) => ({ sessionId: info.sessionId, title: info.title || 'Untitled', updatedAt: (info.updatedAt && Date.parse(info.updatedAt)) || 0 }))
        }
      : undefined,
    close: () => {
      closing = true
      backlog = null
      settleAll()
      close()
    }
  }
}

export const acpAdapter: ChatAdapter = {
  id: 'acp',
  label: 'Agent Client Protocol',
  connect: async ({ cwd, command, instructions, preset, directories, env, resume }) => {
    // Claude Code reads the CLAUDE.md and rules of added folders only with this set
    const child = spawnInShell(command, cwd, directories?.length ? { ...env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : env)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })
    const withTail = (message: string) => new Error(`${message}: ${stderr.trim() || 'no output'}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const failed = new Promise<never>((_, reject) => {
      child.on('error', reject)
      child.once('exit', () => reject(withTail(`${command} exited`)))
      timer = setTimeout(() => reject(withTail(`${command} did not answer in ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)
    })
    failed.catch(() => undefined)

    // Built by hand: Readable.toWeb's Node stream type does not match the DOM ReadableStream the SDK takes
    let done = false
    const fromAgent = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (!done) controller.enqueue(new Uint8Array(chunk))
        })
        // On 'close', after 'exit', so an early exit reports stderr rather than a closed connection
        child.once('close', () => {
          if (done) return
          done = true
          controller.close()
        })
      },
      cancel: () => {
        done = true
        killGroup(child)
      }
    })
    const stream = ndJsonStream(Writable.toWeb(child.stdin), fromAgent)
    try {
      return await Promise.race([
        connectOverStream(stream, {
          cwd,
          resume,
          instructions,
          preset,
          directories,
          close: () => killGroup(child),
          stderrTail: () => stderr,
          mcp: env.TREEIX_MCP_URL && env.TREEIX_MCP_TOKEN ? { url: env.TREEIX_MCP_URL, token: env.TREEIX_MCP_TOKEN } : null
        }),
        failed
      ])
    } catch (error) {
      killGroup(child)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
