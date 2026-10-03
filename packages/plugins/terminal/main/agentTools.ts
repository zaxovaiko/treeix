import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { MainContext, McpTool } from '@treeix/sdk/main'
import { readTranscript, lastReplies } from './transcripts'
import { existingFolder, listeningPorts, pasteTerminal, reportStatus, sessionEntries, writeTerminal } from './pty'

const SCREEN_LINES = 60
/** Lets the agent's input box take the pasted prompt before Enter sends it */
const SUBMIT_DELAY_MS = 150
const START_TIMEOUT_MS = 30_000

type Meta = { title: string; kind: string; worktreePath: string; agentSessionId: string | null }

function parseMeta(meta: string): Meta {
  try {
    const value: unknown = JSON.parse(meta)
    if (typeof value === 'object' && value !== null) {
      const field = (name: string): unknown => Reflect.get(value, name)
      const text = (name: string): string => (typeof field(name) === 'string' ? String(field(name)) : '')
      return { title: text('title'), kind: text('kind'), worktreePath: text('worktreePath'), agentSessionId: text('agentSessionId') || null }
    }
  } catch {
    // Unreadable meta still lists the session
  }
  return { title: '', kind: '', worktreePath: '', agentSessionId: null }
}

/** Plain lines of what a terminal shows; full-screen apps redraw in place, so theirs read rough */
export function screenText(output: string, lines: number): string {
  const plain = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split('\r').at(-1)?.trimEnd() ?? '')
  return plain
    .filter((line, index) => line || plain[index - 1])
    .slice(-lines)
    .join('\n')
    .trim()
}

const findSession = (args: Record<string, unknown>): ReturnType<typeof sessionEntries>[number] => {
  const session = sessionEntries().find((entry) => entry.id === args.session)
  if (!session) throw new Error(`No session ${String(args.session)}; sessions_list lists them`)
  return session
}

const SESSION = { session: { type: 'string', description: 'Session id from sessions_list' } }

/** `window` is the Treeix window that opens the sessions agents start */
export function sessionTools(context: MainContext, window: () => WebContents | null): McpTool[] {
  /** Starts the renderer asked for, by request id: the new session's id, or why it couldn't start */
  const starting = new Map<string, (result: { id: string } | { error: string }) => void>()
  context.on('started', (_, request: string, id: unknown, error: unknown) =>
    starting.get(request)?.(typeof id === 'string' ? { id } : { error: typeof error === 'string' ? error : 'The session did not start' })
  )
  return [
    {
      name: 'sessions_list',
      description: 'Lists the Treeix sessions (Claude, Codex and shell terminals): id, kind, title, state, folder and the ports they listen on.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const ports = await listeningPorts()
        const lines = sessionEntries().map((session) => {
          const meta = parseMeta(session.meta)
          const listening = [...new Set(ports.filter((port) => port.sessionId === session.id).map((port) => port.port))]
          const state = session.alive ? (session.status ?? 'running') : 'exited'
          return `${session.id}  ${meta.kind || 'shell'} "${meta.title}" ${state} ${meta.worktreePath}${listening.length ? ` ports ${listening.join(',')}` : ''}`
        })
        return lines.join('\n') || 'No sessions'
      }
    },
    {
      name: 'session_read',
      description: "A session's latest output: an agent's last replies from its conversation, or a shell's screen.",
      inputSchema: {
        type: 'object',
        properties: { ...SESSION, count: { type: 'number', description: 'Replies or screen lines, 3 and 60 by default' } },
        required: ['session'],
        additionalProperties: false
      },
      run: async (args) => {
        const session = findSession(args)
        const meta = parseMeta(session.meta)
        const count = typeof args.count === 'number' && args.count > 0 ? Math.floor(args.count) : null
        if (meta.agentSessionId && (meta.kind === 'claude' || meta.kind === 'codex')) {
          const replies = lastReplies(meta.kind, await readTranscript({ sessionId: session.id, kind: meta.kind, agentSessionId: meta.agentSessionId }), count ?? 3)
          if (replies.length) return replies.join('\n\n---\n\n')
        }
        return screenText(session.screen(), count ?? SCREEN_LINES) || '(nothing on screen)'
      }
    },
    {
      name: 'session_send',
      description:
        "Types a message into a session: a prompt for an agent, a command for a shell. By default it waits in the session's input, marked for the user, who reads it and sends it; send: 'send' presses Enter too. Read the answer later with session_read.",
      inputSchema: {
        type: 'object',
        properties: {
          ...SESSION,
          text: { type: 'string' },
          send: { type: 'string', enum: ['ask', 'send'], description: "'ask', the default, leaves the text for the user to send; 'send' submits it" }
        },
        required: ['session', 'text'],
        additionalProperties: false
      },
      run: async (args) => {
        const session = findSession(args)
        if (!session.alive) throw new Error('That session has exited')
        if (typeof args.text !== 'string' || !args.text) throw new Error('text is required')
        // Bracketed paste keeps newlines in the message instead of sending it line by line
        pasteTerminal(session.id, args.text)
        if (args.send !== 'send') {
          // The session's "needs you" mark, which goes once the user types in it
          reportStatus(session.id, 'input')
          return `Typed into ${session.id}; it waits there for the user to send it`
        }
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
        writeTerminal(session.id, '\r')
        return `Sent to ${session.id}`
      }
    },
    {
      name: 'session_new',
      description:
        'Starts a new Treeix session as a tab: a Claude or Codex agent, or a shell, in a folder, optionally with a first prompt. Returns its id for session_read and session_send.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Absolute path the session works in' },
          kind: { type: 'string', description: "'claude' by default, 'codex', 'shell', or another agent id from Treeix's settings" },
          prompt: { type: 'string', description: "First message for an agent, or a shell's command" }
        },
        required: ['folder'],
        additionalProperties: false
      },
      run: async (args) => {
        if (typeof args.folder !== 'string' || !isAbsolute(args.folder)) throw new Error('folder must be an absolute path')
        const folder = resolve(args.folder)
        if (existingFolder(folder) !== folder) throw new Error(`No folder ${args.folder}`)
        const kind = typeof args.kind === 'string' && args.kind ? args.kind : 'claude'
        const prompt = typeof args.prompt === 'string' ? args.prompt : ''
        const target = window()
        if (!target) throw new Error('Treeix has no window open')
        const request = randomUUID()
        const result = await new Promise<{ id: string } | { error: string }>((settle) => {
          const timer = setTimeout(() => settle({ error: 'Treeix did not start the session' }), START_TIMEOUT_MS)
          starting.set(request, (started) => (clearTimeout(timer), settle(started)))
          context.send(target, 'start', request, folder, kind, prompt)
        }).finally(() => starting.delete(request))
        if ('error' in result) throw new Error(result.error)
        return `Started ${result.id} (${kind}) in ${folder}`
      }
    }
  ]
}
