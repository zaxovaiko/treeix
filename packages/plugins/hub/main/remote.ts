import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Secrets } from '@treeix/host/secrets'
import { readJsonFile } from '@treeix/host/paths'
import { isJson, isString, list, parseJson, text, type Json } from '@treeix/shared/json'
import type { RemoteStatus } from '../shared/types'
import type { RunEvent } from '../shared/workflow'
import { createVapid, isPushSubscription, type PushSubscription, sendPush, type Vapid } from './push'

const exec = promisify(execFile)

const BODY_LIMIT = 64 * 1024
const HEARTBEAT_MS = 25_000
const TAILSCALE_PATHS = ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
const ENABLE_URL = /https:\/\/login\.tailscale\.com\/\S+/

/** Who may come in: requests for our tailnet name, from the tailnet's owner */
export type Identity = { host: string; owner: string }

/** An API call: path params like `:id`, and the JSON body (empty for GET) */
export type Route = (params: Record<string, string>, body: Json) => unknown
/** Keyed `METHOD path`, path after /api/, e.g. `POST runs/:id/decide`; anything not listed answers 404 */
export type Routes = Record<string, Route>

/**
 * Null when the request may go on, else the status to refuse it with. `tailscale serve` is the only way in: it keeps the
 * Host it was asked for and says which tailnet user asked. A page in some browser can't send those headers to 127.0.0.1
 * (a rebound DNS name still has its own Host), and API calls need a header no cross-site form or image can send.
 */
export function refuse(headers: IncomingHttpHeaders, path: string, identity: Identity | null): number | null {
  if (!identity) return 503
  if (headers.host?.replace(/:443$/, '') !== identity.host) return 421
  if (headers['tailscale-user-login'] !== identity.owner) return 403
  if (headers.origin !== undefined && headers.origin !== `https://${identity.host}`) return 403
  if (path.startsWith('/api/') && headers['x-treeix'] !== '1') return 403
  return null
}

/** The route a request path matches, with its params; `path` is after /api/ */
export function matchRoute(routes: Routes, method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const parts = path.split('/')
  for (const [key, route] of Object.entries(routes)) {
    const [routeMethod, pattern] = key.split(' ')
    const names = pattern.split('/')
    if (routeMethod !== method || names.length !== parts.length) continue
    const params: Record<string, string> = {}
    if (names.every((name, index) => (name.startsWith(':') ? (params[name.slice(1)] = decodeURIComponent(parts[index])) !== '' : name === parts[index]))) return { route, params }
  }
  return null
}

/** Permission questions a run's agents wait on: each node's last one that nothing settled yet */
export function openAsks(events: RunEvent[]): { node: string; requestId: string; title: string; options: { id: string; name: string; kind: string }[] }[] {
  const settled = new Set(events.flatMap(({ event }) => (event.type === 'permission_settled' ? [event.requestId] : [])))
  return events.flatMap(({ node, event }) =>
    event.type === 'permission' && !settled.has(event.requestId) ? [{ node, requestId: event.requestId, title: event.title, options: event.options }] : []
  )
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/** Shows what push sends; a tap opens the run in the web app, focusing it when already open */
const SERVICE_WORKER = `self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  event.waitUntil(self.registration.showNotification(data.title || 'Treeix', { body: data.body || '', tag: data.tag, data: { url: data.url || '/' } }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data.url
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((windows) => {
    const open = windows[0]
    return open ? open.navigate(url).then((client) => (client || open).focus()) : self.clients.openWindow(url)
  }))
})
`

const MANIFEST = JSON.stringify({ name: 'Treeix Agents', short_name: 'Agents', start_url: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000' })

function readBody(request: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > BODY_LIMIT) request.destroy(new Error('Request too large'))
    })
    request.on('end', () => {
      const value = parseJson(body)
      resolve(isJson(value) ? value : {})
    })
    request.on('error', reject)
  })
}

const tailscale = (): string | null => TAILSCALE_PATHS.find((path) => existsSync(path)) ?? null

/** This Mac's tailnet name and owner, from the Tailscale CLI */
async function readIdentity(cli: string): Promise<Identity> {
  const status = parseJson((await exec(cli, ['status', '--json'])).stdout)
  const self = isJson(status) && isJson(status.Self) ? status.Self : {}
  const users = isJson(status) && isJson(status.User) ? status.User : {}
  const user = users[String(self.UserID)]
  const host = text(self.DNSName).replace(/\.$/, '')
  const owner = isJson(user) ? text(user.LoginName) : ''
  if (!host || !owner) throw new Error('Tailscale is not signed in')
  return { host, owner }
}

/**
 * The hub's web app and API, served on 127.0.0.1 and put on the tailnet with `tailscale serve`, so the phone can follow
 * and steer runs. Push subscriptions are the devices that get notified.
 */
export function createRemote(deps: { dataPath: string; secrets: Secrets; staticDir: string; routes: Routes; onStatus: (status: RemoteStatus) => void }): {
  status: () => RemoteStatus
  setOn: (on: boolean) => Promise<void>
  publish: (data: unknown) => void
  notify: (message: { title: string; body: string; url: string; tag?: string }) => Promise<number>
  forgetDevices: () => Promise<void>
  dispose: () => void
} {
  const configFile = join(deps.dataPath, 'remote.json')
  const devicesFile = join(deps.dataPath, 'push.json')
  let identity: Identity | null = null
  let server: Server | null = null
  let serving: ChildProcess | null = null
  let state: RemoteStatus = { on: false, url: null, enableUrl: null, error: null, devices: 0 }
  const streams = new Set<ServerResponse>()

  const set = (next: Partial<RemoteStatus>): void => {
    state = { ...state, ...next }
    deps.onStatus(state)
  }
  const devices = async (): Promise<PushSubscription[]> => list(await readJsonFile(devicesFile), isPushSubscription)
  const saveDevices = async (next: PushSubscription[]): Promise<void> => {
    await writeFile(devicesFile, JSON.stringify(next, null, 2), { mode: 0o600 })
    set({ devices: next.length })
  }
  void devices().then((saved) => set({ devices: saved.length }))

  const vapid = async (): Promise<Vapid> => {
    const saved = parseJson(await deps.secrets.get('vapid'))
    if (isJson(saved) && isString(saved.publicKey) && isString(saved.privateKey)) return { publicKey: saved.publicKey, privateKey: saved.privateKey }
    const fresh = createVapid()
    await deps.secrets.set('vapid', JSON.stringify(fresh))
    return fresh
  }

  const routes: Routes = {
    ...deps.routes,
    'GET push/key': async () => (await vapid()).publicKey,
    'POST push': async (_, body) => {
      if (!isPushSubscription(body)) throw new Error('Not a push subscription')
      const subscription = { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }
      await saveDevices([...(await devices()).filter((device) => device.endpoint !== body.endpoint), subscription])
    }
  }

  async function serveFile(path: string, response: ServerResponse): Promise<void> {
    const name = path === '/' ? '/remote.html' : path
    const file = normalize(join(deps.staticDir, decodeURIComponent(name)))
    if (!file.startsWith(deps.staticDir + sep)) return void response.writeHead(404).end()
    try {
      const body = await readFile(file)
      response.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': name.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-cache'
      })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const refused = refuse(request.headers, path, identity)
    if (refused !== null) return void response.writeHead(refused).end()
    if (path === '/sw.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }).end(SERVICE_WORKER)
    if (path === '/manifest.webmanifest') return void response.writeHead(200, { 'Content-Type': 'application/manifest+json' }).end(MANIFEST)
    if (!path.startsWith('/api/')) return request.method === 'GET' ? serveFile(path, response) : void response.writeHead(405).end()
    if (path === '/api/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }).write(': hi\n\n')
      streams.add(response)
      request.on('close', () => streams.delete(response))
      return
    }
    const match = matchRoute(routes, request.method ?? '', path.slice('/api/'.length))
    if (!match) return void response.writeHead(404).end()
    try {
      const result = await match.route(match.params, request.method === 'GET' ? {} : await readBody(request))
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? null))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const heartbeat = setInterval(() => streams.forEach((stream) => stream.write(': beat\n\n')), HEARTBEAT_MS)

  /** Starts the server on its saved port, so the serve config tailscaled keeps still points at it */
  async function listen(): Promise<number> {
    const config = await readJsonFile(configFile)
    const saved = isJson(config) && typeof config.port === 'number' ? config.port : 0
    const next = createServer((request, response) => void handle(request, response))
    const port = await new Promise<number>((resolve, reject) => {
      next.once('error', reject)
      next.listen(saved, '127.0.0.1', () => {
        const address = next.address()
        resolve(typeof address === 'object' && address ? address.port : saved)
      })
    })
    server = next
    await writeFile(configFile, JSON.stringify({ on: true, port }))
    return port
  }

  /** Runs `tailscale serve`; when the tailnet hasn't turned Serve on it waits for that, and finishes once it is */
  function serve(cli: string, port: number): void {
    const child = spawn(cli, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`])
    serving = child
    let output = ''
    const read = (chunk: Buffer): void => {
      output += chunk.toString()
      const enableUrl = ENABLE_URL.exec(output)?.[0]
      if (enableUrl && !state.enableUrl) set({ enableUrl })
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('close', (code) => {
      if (serving !== child) return
      serving = null
      if (code === 0) set({ enableUrl: null, url: `https://${identity?.host}` })
      else set({ enableUrl: null, error: output.trim() || `tailscale serve ended with ${code}` })
    })
  }

  async function start(): Promise<void> {
    const cli = tailscale()
    if (!cli) return set({ on: true, error: 'Install Tailscale first' })
    try {
      identity = await readIdentity(cli)
      const port = server ? null : await listen()
      set({ on: true, error: null })
      if (port !== null) serve(cli, port)
    } catch (error) {
      set({ on: true, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function stop(): Promise<void> {
    serving?.kill()
    serving = null
    streams.forEach((stream) => stream.end())
    streams.clear()
    server?.close()
    server = null
    const cli = tailscale()
    if (cli) await exec(cli, ['serve', '--https=443', 'off']).catch(() => undefined)
    const config = await readJsonFile(configFile)
    await writeFile(configFile, JSON.stringify({ ...(isJson(config) ? config : {}), on: false }))
    set({ on: false, url: null, enableUrl: null, error: null })
  }

  void readJsonFile(configFile).then((config) => {
    if (isJson(config) && config.on === true) void start()
  })

  return {
    status: () => state,
    setOn: (on) => (on ? start() : stop()),
    publish: (data) => streams.forEach((stream) => stream.write(`data: ${JSON.stringify(data)}\n\n`)),
    notify: async (message) => {
      const saved = await devices()
      if (!saved.length || !identity) return 0
      const keys = await vapid()
      const subject = `https://${identity.host}`
      const payload = JSON.stringify(message)
      const alive = await Promise.all(saved.map((device) => sendPush(device, payload, keys, subject).catch((error: unknown) => (console.error('[hub] Push failed', error), true))))
      if (alive.includes(false)) await saveDevices(saved.filter((_, index) => alive[index]))
      return alive.filter(Boolean).length
    },
    forgetDevices: () => saveDevices([]),
    dispose: () => {
      clearInterval(heartbeat)
      serving?.kill()
      streams.forEach((stream) => stream.end())
      server?.close()
    }
  }
}
