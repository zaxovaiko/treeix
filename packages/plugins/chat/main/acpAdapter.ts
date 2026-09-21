import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type RequestPermissionResponse, type Stream } from '@agentclientprotocol/sdk'
import type { ChatAdapter, ChatConnection, ChatEvent, ChatOption } from '@treeix/sdk/main'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { fromPermissionRequest, fromSessionUpdate, optionsFrom, toPromptBlocks } from './acpEvents'
import { spawnInShell } from './shell'

const STDERR_LIMIT = 4096

/** The agent may only touch files inside the session's folder or the user's home */
function allowedPath(path: string, cwd: string): string {
  const target = resolve(path)
  const inside = (root: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  if (!inside(resolve(cwd)) && !inside(homedir())) throw new Error('Outside the session folder')
  return target
}

export async function connectOverStream(stream: Stream, { cwd, resume, close }: { cwd: string; resume: string | null; close: () => void }): Promise<ChatConnection> {
  const listeners = new Set<(event: ChatEvent) => void>()
  // Events before the first listener (options, a loaded session's replay) wait for it
  let backlog: ChatEvent[] | null = []
  const emit = (event: ChatEvent) => {
    if (event.type === 'options') options = event.options
    if (backlog) backlog.push(event)
    else for (const listener of listeners) listener(event)
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
    readTextFile: async ({ path, line, limit }) => {
      const content = await readFile(allowedPath(path, cwd), 'utf8')
      if (line == null && limit == null) return { content }
      const start = Math.max((line ?? 1) - 1, 0)
      const lines = content.split('\n')
      return { content: lines.slice(start, limit == null ? undefined : start + limit).join('\n') }
    },
    writeTextFile: async ({ path, content }) => {
      await writeFile(allowedPath(path, cwd), content, 'utf8')
      return {}
    }
  }

  const connection = new ClientSideConnection(() => client, stream)
  const { agentCapabilities } = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
  })
  const canLoad = agentCapabilities?.loadSession === true
  const canList = Boolean(agentCapabilities?.sessionCapabilities?.list)

  const { sessionId, session } =
    resume && canLoad
      ? { sessionId: resume, session: await connection.loadSession({ sessionId: resume, cwd, mcpServers: [] }) }
      : await connection.newSession({ cwd, mcpServers: [] }).then((session) => ({ sessionId: session.sessionId, session }))
  const hasConfigOptions = Boolean(session?.configOptions?.length)
  emit({ type: 'options', options: optionsFrom(session) })

  return {
    sessionId,
    capabilities: { images: agentCapabilities?.promptCapabilities?.image === true, load: canLoad, list: canList },
    onEvent: (listener) => {
      listeners.add(listener)
      const queued = backlog
      backlog = null
      for (const event of queued ?? []) listener(event)
      return () => listeners.delete(listener)
    },
    prompt: async (content) => {
      emit({ type: 'turn_start' })
      try {
        const { stopReason } = await connection.prompt({ sessionId, prompt: toPromptBlocks(content) })
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
    setOption: async (id, value) => {
      if (hasConfigOptions) {
        const response = await connection.setSessionConfigOption({ sessionId, configId: id, value })
        emit({ type: 'options', options: optionsFrom(response) })
        return
      }
      if (id !== 'mode') return
      await connection.setSessionMode({ sessionId, modeId: value })
      emit({ type: 'options', options: withCurrentValue(id, value) })
    },
    list: canList
      ? async (folder) => {
          const { sessions } = await connection.listSessions({ cwd: folder })
          return sessions.map((info) => ({ sessionId: info.sessionId, title: info.title || 'Untitled', updatedAt: (info.updatedAt && Date.parse(info.updatedAt)) || 0 }))
        }
      : undefined,
    close: () => {
      settleAll()
      close()
    }
  }
}

export const acpAdapter: ChatAdapter = {
  id: 'acp',
  label: 'Agent Client Protocol',
  connect: async ({ cwd, command, env, resume }) => {
    const child = spawnInShell(command, cwd, env)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })
    const failed = new Promise<never>((_, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`${command} exited: ${stderr.trim() || 'no output'}`)))
    })
    failed.catch(() => undefined)

    // Built by hand: Readable.toWeb's Node stream type does not match the DOM ReadableStream the SDK takes
    const fromAgent = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        // On 'close', after 'exit', so an early exit reports stderr rather than a closed connection
        child.once('close', () => controller.close())
      },
      cancel: () => {
        child.kill()
      }
    })
    const stream = ndJsonStream(Writable.toWeb(child.stdin), fromAgent)
    try {
      return await Promise.race([connectOverStream(stream, { cwd, resume, close: () => child.kill() }), failed])
    } catch (error) {
      child.kill()
      throw error
    }
  }
}
