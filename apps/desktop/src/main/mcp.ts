import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { withoutAgentVariables } from './env'
import type { McpContent, McpTool } from '@treeix/sdk/main'

/** Newest first; an agent asking for one of these gets it back, anything else gets the newest */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const BODY_LIMIT = 4 * 1024 * 1024
export const SERVER_NAME = 'treeix'

const INSTRUCTIONS = [
  'Tools of Treeix, the app this session runs in.',
  'The browser_* tools drive Treeix\'s built-in browser, which the user sees next to this session. Use them for every web page, localhost dev servers included, instead of chrome-devtools, playwright or any other browser tool, which open a separate browser the user can\'t see.',
  'Read a page with browser_snapshot and act on the refs it prints; take a screenshot only when the looks matter.'
].join('\n')

/** Tools by name, as plugins register them while enabled */
const tools = new Map<string, McpTool>()

export function registerMcpTool(tool: McpTool): () => void {
  tools.set(tool.name, tool)
  return () => {
    if (tools.get(tool.name) === tool) tools.delete(tool.name)
  }
}

type Request = { id?: string | number | null; method?: unknown; params?: unknown }
type Reply = { result: unknown } | { error: { code: number; message: string } }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

async function callTool(params: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
  const tool = tools.get(String(params.name))
  if (!tool) return { content: [{ type: 'text', text: `No tool named ${String(params.name)}; the plugin that offers it may be off` }], isError: true }
  try {
    const result = await tool.run(isObject(params.arguments) ? params.arguments : {})
    return { content: typeof result === 'string' ? [{ type: 'text', text: result }] : result }
  } catch (reason) {
    return { content: [{ type: 'text', text: reason instanceof Error ? reason.message : String(reason) }], isError: true }
  }
}

/** One JSON-RPC message; null for notifications, which get no answer */
export async function answer(request: Request): Promise<Reply | null> {
  if (request.id === undefined || request.id === null) return null
  const params = isObject(request.params) ? request.params : {}
  switch (request.method) {
    case 'initialize': {
      const asked = String(params.protocolVersion)
      return {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: app.getVersion() },
          instructions: INSTRUCTIONS
        }
      }
    }
    case 'ping':
      return { result: {} }
    case 'tools/list':
      return { result: { tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
    case 'tools/call':
      return { result: await callTool(params) }
    default:
      return { error: { code: -32601, message: `Unknown method ${String(request.method)}` } }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > BODY_LIMIT) request.destroy(new Error('Request too large'))
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

/**
 * Port and token survive restarts, so agents set up outside Treeix keep reaching it; a new token or a taken port means
 * setting them up again. Loaded with the server, after the app has picked its data folder.
 */
type Saved = { port: number; token: string }
const savedPath = (): string => join(app.getPath('userData'), 'mcp.json')
function loadSaved(): Saved {
  try {
    const value: unknown = JSON.parse(readFileSync(savedPath(), 'utf8'))
    const port = typeof value === 'object' && value !== null ? Reflect.get(value, 'port') : null
    const saved = typeof value === 'object' && value !== null ? Reflect.get(value, 'token') : null
    if (typeof port === 'number' && typeof saved === 'string' && /^[0-9a-f]{64}$/.test(saved)) return { port, token: saved }
  } catch {
    // First launch, or an unreadable file: start over
  }
  return { port: 0, token: randomBytes(32).toString('hex') }
}

let token = ''
const authorized = (header: string | undefined): boolean => {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const send = (status: number, body?: unknown): void => {
    response.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body))
  }
  // Web pages send an Origin; agents don't, so a page in any browser can't reach these tools through a rebound DNS name
  if (request.headers.origin || !authorized(request.headers.authorization)) return send(401)
  if (request.url !== '/mcp') return send(404)
  // No server-initiated messages, so there is no event stream to open
  if (request.method !== 'POST') return send(405)
  let message: unknown
  try {
    message = JSON.parse(await readBody(request))
  } catch {
    return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON' } })
  }
  if (!isObject(message)) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } })
  const reply = await answer(message)
  if (!reply) return send(202)
  send(200, { jsonrpc: '2.0', id: message.id, ...reply })
}

let url: Promise<string | null> | null = null
const serverUrl = (): Promise<string | null> => {
  url ??= new Promise((resolve) => {
    const saved = loadSaved()
    token = saved.token
    const server = createServer((request, response) => void handle(request, response).catch(() => response.headersSent || response.writeHead(500).end()))
    const listen = (port: number): void => {
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address !== 'object') return resolve(null)
        void writeFile(savedPath(), JSON.stringify({ port: address.port, token }), { mode: 0o600 }).catch(() => undefined)
        resolve(`http://127.0.0.1:${address.port}/mcp`)
      })
    }
    // Another app took the saved port: any free one, and agents set up outside need setting up again
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE' || !saved.port) return resolve(null)
      saved.port = 0
      listen(0)
    })
    listen(saved.port)
    app.once('will-quit', () => server.close())
  })
  return url
}

const tomlString = (value: string): string => JSON.stringify(value)

/**
 * How sessions reach the server: `claude --mcp-config "$TREEIX_CLAUDE_MCP"`, `codex -c "$TREEIX_CODEX_MCP"`,
 * and the URL and token for chat adapters. Empty when the server couldn't start; the terminal plugin fills in no-ops.
 */
export async function mcpEnv(): Promise<Record<string, string>> {
  const address = await serverUrl()
  if (!address) return {}
  const authorization = `Bearer ${token}`
  return {
    TREEIX_MCP_URL: address,
    TREEIX_MCP_TOKEN: token,
    TREEIX_CLAUDE_MCP: JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: address, headers: { Authorization: authorization } } } }),
    TREEIX_CODEX_MCP: `mcp_servers.${SERVER_NAME}={url=${tomlString(address)},http_headers={Authorization=${tomlString(authorization)}}}`
  }
}

const run = promisify(execFile)
const codexConfig = (): string => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
const readText = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')

/** The treeix table Codex's config.toml holds, up to the next table */
const codexSection = (config: string): string => config.match(new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\n[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, 'm'))?.[0] ?? ''

export type McpInstall = { agent: 'Claude Code' | 'Codex'; state: 'installed' | 'outdated' | 'missing' }

/** Whether Claude Code and Codex, when they're set up on this Mac, reach this server from any terminal */
export async function mcpInstallStatus(): Promise<McpInstall[]> {
  const address = await serverUrl()
  const [claudeJson, codexToml] = await Promise.all([readText(join(homedir(), '.claude.json')), readText(codexConfig())])
  const found: McpInstall[] = []
  if (claudeJson) {
    let entry: unknown = null
    try {
      const servers: unknown = Reflect.get(JSON.parse(claudeJson) as object, 'mcpServers')
      entry = typeof servers === 'object' && servers !== null ? Reflect.get(servers, SERVER_NAME) : null
    } catch {
      // Claude rewrites the file as it runs; a torn read shows as not set up
    }
    const current = typeof entry === 'object' && entry !== null && Reflect.get(entry, 'url') === address && JSON.stringify(Reflect.get(entry, 'headers') ?? {}).includes(token)
    found.push({ agent: 'Claude Code', state: !entry ? 'missing' : current ? 'installed' : 'outdated' })
  }
  // Codex keeps its folder from the first run, before any config.toml
  if (codexToml || existsSync(dirname(codexConfig()))) {
    const section = codexSection(codexToml)
    found.push({ agent: 'Codex', state: !section ? 'missing' : address && section.includes(address) && section.includes(token) ? 'installed' : 'outdated' })
  }
  return found
}

/**
 * Adds this server to Claude Code's and Codex's user config, replacing an older entry. The token goes into those
 * files: anything running as you could read it there, as it can read Treeix's own data.
 */
export async function installMcp(): Promise<{ installed: string[]; failed: string[] }> {
  const address = await serverUrl()
  if (!address) return { installed: [], failed: ['the Treeix MCP server is not running'] }
  const authorization = `Bearer ${token}`
  const env = withoutAgentVariables(process.env)
  const installed: string[] = []
  const failed: string[] = []
  const attempt = async (agent: string, install: () => Promise<unknown>): Promise<void> => {
    try {
      await install()
      installed.push(agent)
    } catch (reason) {
      // Not on PATH: nothing to set up
      if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(agent)
    }
  }
  await attempt('Claude Code', async () => {
    await run('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { env }).catch(() => undefined)
    await run('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, address, '--header', `Authorization: ${authorization}`], { env })
  })
  await attempt('Codex', async () => {
    await run('codex', ['--version'], { env })
    const path = codexConfig()
    const config = await readText(path)
    const table = `[mcp_servers.${SERVER_NAME}]\nurl = ${tomlString(address)}\nhttp_headers = { Authorization = ${tomlString(authorization)} }\n`
    const section = codexSection(config)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, section ? config.replace(section, `${table}\n`) : `${config}${config && !config.endsWith('\n') ? '\n' : ''}\n${table}`)
  })
  return { installed, failed }
}
