import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { withoutAgentVariables } from '@treeix/host/env'

const TITLE_TIMEOUT_MS = 60_000
const MAX_MESSAGE = 2000

const PROMPT = `Name a coding chat that starts with the message below, like a short task title: 2 to 5 words, same language as the message, no quotes, no trailing punctuation. Reply with the name only.

Message:
`

/** The model's first line without the quotes or full stop it sometimes adds */
const bareName = (output: string): string =>
  output
    .trim()
    .split('\n')[0]
    .replace(/^["'`]+|["'`.]+$/g, '')

/** A short name for a chat from its first message, by Claude's smallest model, the way Claude Code names its sessions */
export function nameChat(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      // No MCP servers, hooks or settings to load: a bare one-shot answers in about 3s instead of 12s
      ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', ''],
      { cwd: tmpdir(), timeout: TITLE_TIMEOUT_MS, env: withoutAgentVariables(process.env) },
      (error, stdout) => (error ? reject(error) : resolve(bareName(String(stdout))))
    )
    child.stdin?.end(PROMPT + message.slice(0, MAX_MESSAGE))
  })
}
