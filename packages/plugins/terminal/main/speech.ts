import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { withoutAgentVariables } from '@treeix/host/env'

const SUMMARY_TIMEOUT_MS = 90_000

/** Markdown as it sounds read out: code blocks and tables named instead of spelled, links by their text, no markup */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '\nA code block.\n')
    .replace(/^(\|.*\|\s*\n?)+/gm, 'A table.\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

const PROMPT = `Summarize this reply from a coding agent so it can be read aloud in under 30 seconds. Plain spoken sentences: no markdown, no lists, no code, file paths only when they matter. Keep any question the agent asks the user. Same language as the reply. Reply with the summary only.

Reply:
`

/** Each agent's CLI in one-shot mode, reading the prompt on stdin and printing only its answer */
const SUMMARIZERS: Record<string, [string, string[]]> = {
  claude: ['claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '']],
  codex: ['codex', ['exec', '--skip-git-repo-check', '--ephemeral', '-']]
}

/** The reply summarized by the agent that wrote it; Claude for other agents */
export function summarize(kind: string, reply: string): Promise<string> {
  const [file, args] = SUMMARIZERS[kind] ?? SUMMARIZERS.claude
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd: tmpdir(), timeout: SUMMARY_TIMEOUT_MS, env: withoutAgentVariables(process.env) }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim())
    )
    child.stdin?.end(PROMPT + reply)
  })
}
