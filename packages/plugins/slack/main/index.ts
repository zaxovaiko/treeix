import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MainPlugin } from '@treeix/sdk/main'
import { createSecrets } from '@treeix/host/secrets'
import { isJson, isString, type Json, object, parseJson, text } from '@treeix/shared/json'
import { type Status, type Trigger, triggerOf } from '../shared/types'
import { isHumanMessage, type Message, permalink, render, withNames } from './messages'

const API = 'https://slack.com/api'
const TIMEOUT_MS = 30_000
const RECONNECT_MS = [5_000, 15_000, 60_000, 300_000]
const MINUTE_MS = 60_000
const TOKENS = { app: 'xapp-', user: 'xoxp-' } as const
type Token = keyof typeof TOKENS

async function slack(token: string, method: string, params: Record<string, string> = {}, verb = 'GET'): Promise<Json> {
  const response = await fetch(`${API}/${method}?${new URLSearchParams(params)}`, {
    method: verb,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const reply: unknown = await response.json().catch(() => null)
  if (!isJson(reply) || reply.ok !== true) throw new Error(`Slack ${method}: ${isJson(reply) ? text(reply.error) : response.status}`)
  return reply
}

const lines = (data: Buffer | string): number => data.toString().split('\n').filter(Boolean).length
const clock = (ts: string): string => new Date(Number(ts) * 1000).toTimeString().slice(0, 5)

const plugin: MainPlugin = {
  activate: (context) => {
    const secrets = createSecrets(join(context.dataPath, 'secrets.bin'))
    const pendingPath = join(context.dataPath, 'pending.jsonl')
    let status: Status = { connected: false, pending: 0, error: null, lastBatch: null }
    const setStatus = (patch: Partial<Status>): void => {
      status = { ...status, ...patch }
      context.broadcast('status', status)
    }
    let disposed = false
    let socket: WebSocket | null = null
    let attempt = 0
    let reconnectTimer: NodeJS.Timeout | undefined
    let batching = false
    const users = new Map<string, string>()
    const channels = new Map<string, string>()

    // Appends and the cut after a batch take turns, so a message landing mid-batch stays for the next one
    let queue: Promise<unknown> = Promise.resolve()
    const serial = (task: () => Promise<void>): Promise<void> => {
      const next = queue.then(task)
      queue = next.catch(() => undefined)
      return next
    }
    const append = (event: Json): Promise<void> =>
      serial(async () => {
        await appendFile(pendingPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
        setStatus({ pending: status.pending + 1 })
      })
    const cut = (bytes: number): Promise<void> =>
      serial(async () => {
        const rest = (await readFile(pendingPath)).subarray(bytes)
        await writeFile(pendingPath, rest, { mode: 0o600 })
        setStatus({ pending: lines(rest) })
      })

    /** Read from AI Hub each time, so a workflow's trigger edits apply without telling Slack; its defaults while the hub is off */
    const trigger = (): Promise<Trigger> =>
      context.callTool('hub_workflows', {}).then(
        (reply) => triggerOf(parseJson(reply)),
        () => triggerOf(null)
      )

    function reconnect(): void {
      socket = null
      setStatus({ connected: false })
      if (disposed) return
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => void connect(), RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)])
    }

    /** Socket Mode: Slack pushes every message event the app is subscribed to; each envelope is acknowledged or Slack sends it again */
    async function connect(): Promise<void> {
      socket?.close()
      socket = null
      const appToken = await secrets.get('app')
      if (!appToken || disposed) return setStatus({ connected: false })
      try {
        const ws = new WebSocket(text((await slack(appToken, 'apps.connections.open', {}, 'POST')).url))
        socket = ws
        ws.onmessage = (message) => {
          const envelope = parseJson(String(message.data))
          if (!isJson(envelope)) return
          if (isString(envelope.envelope_id)) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
          if (envelope.type === 'hello') {
            attempt = 0
            setStatus({ connected: true, error: null })
          }
          if (envelope.type === 'disconnect') ws.close()
          const event = object(object(envelope.payload).event)
          if (envelope.type === 'events_api' && isHumanMessage(event)) append(event).catch((reason: unknown) => setStatus({ error: `Couldn't keep a message: ${String(reason)}` }))
        }
        ws.onclose = () => socket === ws && reconnect()
      } catch (reason) {
        setStatus({ error: String(reason) })
        reconnect()
      }
    }

    /** Hands what arrived since the last batch to the workflows that start on slack.messages; kept until one takes it */
    async function batch(): Promise<void> {
      if (batching) return
      batching = true
      try {
        const data = await readFile(pendingPath).catch(() => Buffer.alloc(0))
        if (!data.length) return
        const userToken = await secrets.get('user')
        if (!userToken) return setStatus({ error: 'Add the user token to send messages on' })
        const { includeOwn } = await trigger()
        const me = await slack(userToken, 'auth.test')
        const myId = text(me.user_id)
        const userName = async (id: string): Promise<string> => {
          if (id === myId) return 'Me'
          if (!users.has(id)) {
            const user = object((await slack(userToken, 'users.info', { user: id })).user)
            users.set(id, text(object(user.profile).real_name) || text(user.real_name) || text(user.name) || id)
          }
          return users.get(id) ?? id
        }
        const channelName = async (event: Json): Promise<string> => {
          if (event.channel_type === 'im') return 'DM'
          if (event.channel_type === 'mpim') return 'group DM'
          const id = text(event.channel)
          if (!channels.has(id)) channels.set(id, `#${text(object((await slack(userToken, 'conversations.info', { channel: id })).channel).name)}`)
          return channels.get(id) ?? id
        }
        const messages: Message[] = []
        for (const event of data.toString().split('\n').map(parseJson).filter(isJson)) {
          if (!includeOwn && event.user === myId) continue
          const ts = text(event.ts)
          messages.push({
            channel: await channelName(event),
            user: await userName(text(event.user)),
            text: await withNames(text(event.text), userName),
            ts,
            permalink: permalink(text(me.url), text(event.channel), ts),
            thread: isString(event.thread_ts) && event.thread_ts !== ts
          })
        }
        if (messages.length) {
          const from = messages[0].ts
          const to = messages[messages.length - 1].ts
          const payload = {
            title: `Slack ${clock(from)}-${clock(to)}`,
            from: new Date(Number(from) * 1000).toISOString(),
            to: new Date(Number(to) * 1000).toISOString(),
            messages,
            text: render(messages)
          }
          if (!(await context.emit('messages', payload))) return setStatus({ error: 'No AI Hub workflow starts on Slack messages, so they wait for one' })
        }
        await cut(data.length)
        setStatus({ error: null, lastBatch: Date.now() })
      } catch (reason) {
        setStatus({ error: String(reason) })
      } finally {
        batching = false
      }
    }

    context.handle('status', () => status)
    context.handle('tokens', async () => ({ app: (await secrets.get('app')) !== null, user: (await secrets.get('user')) !== null }))
    context.handle('setToken', async (_, kind: Token, token: string | null) => {
      if (token !== null) {
        if (!token.startsWith(TOKENS[kind])) throw new Error(`This one starts with ${TOKENS[kind]}`)
        // The app token is proven by connecting with it below
        if (kind === 'user') await slack(token, 'auth.test')
      }
      await secrets.set(kind, token)
      if (kind === 'app') await connect()
    })
    context.handle('batch', () => batch())

    void readFile(pendingPath).then(
      (data) => setStatus({ pending: lines(data) }),
      () => undefined
    )
    void connect()
    // Counted in minutes, so a shorter interval set on a workflow takes over within one
    let idleMin = 0
    const batchTimer = setInterval(
      () =>
        void trigger().then(({ intervalMin }) => {
          if (++idleMin < intervalMin) return
          idleMin = 0
          void batch()
        }),
      MINUTE_MS
    )
    context.onDispose(() => {
      disposed = true
      clearTimeout(reconnectTimer)
      clearInterval(batchTimer)
      socket?.close()
    })
  }
}

export default plugin
