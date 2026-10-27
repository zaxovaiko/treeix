import { Channel } from '@tauri-apps/api/core'
import { commands, type LspOutput } from '../../ipc/bindings'

/** JSON-RPC to one language server process (src-tauri/src/lsp.rs) */
export interface Rpc {
  request<T>(method: string, params: unknown): Promise<T>
  notify(method: string, params: unknown): void
  /** `shutdown`, `exit`, then the process is killed */
  stop(): Promise<void>
}

interface Message {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

const STOP_WAIT_MS = 2000

const isMessage = (value: unknown): value is Message => typeof value === 'object' && value !== null && ('id' in value || 'method' in value)

function parse(body: string): Message | null {
  try {
    const value: unknown = JSON.parse(body)
    return isMessage(value) ? value : null
  } catch {
    return null
  }
}

/** What the client says to requests from the server: settings are the server's defaults, the rest is acknowledged */
function answer(method: string, params: unknown): Pick<Message, 'result' | 'error'> {
  if (method === 'workspace/configuration') {
    const items = typeof params === 'object' && params !== null && 'items' in params && Array.isArray(params.items) ? params.items : []
    return { result: items.map(() => null) }
  }
  if (['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create', 'window/showMessageRequest'].includes(method)) return { result: null }
  return { error: { message: `${method} is not supported` } }
}

export async function startRpc(root: string, command: string[], onNotify: (method: string, params: unknown) => void, onExit: (code: number | null, stderr: string) => void): Promise<Rpc> {
  let next = 0
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  const channel = new Channel<LspOutput>()
  let id = -1
  const send = (message: Message) => void commands.lspSend(id, JSON.stringify({ jsonrpc: '2.0', ...message })).catch(() => {})
  channel.onmessage = (output) => {
    if (output.type === 'exit') {
      pending.forEach(({ reject }) => reject(new Error('the language server exited')))
      pending.clear()
      return onExit(output.code, output.stderr)
    }
    const message = parse(output.body)
    if (!message) return
    if (message.method === undefined) {
      const waiting = pending.get(Number(message.id))
      pending.delete(Number(message.id))
      if (message.error) waiting?.reject(new Error(message.error.message))
      else waiting?.resolve(message.result ?? null)
    } else if (message.id !== undefined) send({ id: message.id, ...answer(message.method, message.params) })
    else onNotify(message.method, message.params)
  }
  id = await commands.lspStart(root, command, channel)
  const rpc: Rpc = {
    request: <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const request = ++next
        // ponytail: results are typed by the caller, not checked; a server that breaks LSP breaks its own features only
        pending.set(request, { resolve: (result) => resolve(result as T), reject })
        send({ id: request, method, params })
      }),
    notify: (method, params) => send({ method, params }),
    stop: async () => {
      await Promise.race([rpc.request('shutdown', null), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]).catch(() => {})
      rpc.notify('exit', null)
      await commands.lspStop(id)
    }
  }
  return rpc
}
