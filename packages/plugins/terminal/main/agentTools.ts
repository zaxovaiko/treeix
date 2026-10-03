import type { McpTool } from '@treeix/sdk/main'
import { readTranscript, lastReplies } from './transcripts'
import { listeningPorts, pasteTerminal, sessionEntries, writeTerminal } from './pty'

const SCREEN_LINES = 60
/** Lets the agent's input box take the pasted prompt before Enter sends it */
const SUBMIT_DELAY_MS = 150

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

export function sessionTools(): McpTool[] {
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
      description: 'Types a message into a session and presses Enter: a prompt for an agent, a command for a shell. Read the answer later with session_read.',
      inputSchema: { type: 'object', properties: { ...SESSION, text: { type: 'string' } }, required: ['session', 'text'], additionalProperties: false },
      run: async (args) => {
        const session = findSession(args)
        if (!session.alive) throw new Error('That session has exited')
        if (typeof args.text !== 'string' || !args.text) throw new Error('text is required')
        // Bracketed paste keeps newlines in the message instead of sending it line by line
        pasteTerminal(session.id, args.text)
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
        writeTerminal(session.id, '\r')
        return `Sent to ${session.id}`
      }
    }
  ]
}
