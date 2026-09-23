import { execFile } from 'node:child_process'

// Set when this app is itself launched from an agent (e.g. `bun run dev` inside Claude Code).
// Passing them on makes `claude` in our terminals think it is a nested child session.
const AGENT_VARIABLE = /^(CLAUDE|ANTHROPIC_BASE_URL$|AI_AGENT$|MCP_|CODEX_)/

export function withoutAgentVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !AGENT_VARIABLE.test(entry[0]))
  )
}

const PATH_MARK = '__TREEIX_PATH__'

/** The PATH between the markers an interactive shell printed; rc files may print their own lines around it */
export function markedPath(output: string): string | null {
  const match = output.match(new RegExp(`${PATH_MARK}(.*)${PATH_MARK}`))
  return match?.[1] || null
}

/**
 * An app opened from the Dock gets a bare PATH, and `zsh -lc` never reads .zshrc, where version managers like fnm or
 * nvm put node; the interactive login shell's PATH is what terminals see, so commands resolve the same everywhere.
 */
export function loadShellPath(): Promise<void> {
  return new Promise((done) => {
    const script = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`
    execFile(process.env.SHELL ?? '/bin/zsh', ['-ilc', script], { timeout: 5000, env: withoutAgentVariables(process.env) }, (_error, stdout) => {
      const path = markedPath(String(stdout))
      if (path) process.env.PATH = [...new Set([...path.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':')
      done()
    })
  })
}
