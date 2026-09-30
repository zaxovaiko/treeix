import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isJson } from '@treeix/shared/json'
import { readJsonFile } from '@treeix/host/paths'

type StatusLine = { command: string; padding: number | null }

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Claude Code hands every status line command its session state, including the account's
 * rate_limits after each API response. The bridge keeps that input for the title bar, and each session's for the
 * terminal plugin, which reads the session's cost from it (see its USAGE_PREFIX). Then it
 * runs the user's own status line on the same input so their terminal looks unchanged.
 */
export function bridgeScript(statusFile: string): string {
  return `#!/bin/sh
umask 077
input=$(cat)
case "$input" in
  *'"rate_limits"'*) printf '%s' "$input" > ${shellQuote(`${statusFile}.tmp`)} && mv -f ${shellQuote(`${statusFile}.tmp`)} ${shellQuote(statusFile)} ;;
esac
if [ -n "$TREEIX_AGENT_STATUS" ] && [ -n "$TREEIX_SESSION_ID" ]; then
  printf '%s' "$input" > "$TREEIX_AGENT_STATUS/usage-$TREEIX_SESSION_ID" 2>/dev/null
fi
if [ -n "$TREEIX_PREVIOUS_STATUSLINE" ]; then
  printf '%s' "$input" | sh -c "$TREEIX_PREVIOUS_STATUSLINE"
fi
`
}

/** The status line from the user's Claude Code settings, which the bridge keeps showing */
export function userStatusLine(settings: unknown): StatusLine | null {
  const statusLine = isJson(settings) && isJson(settings.statusLine) ? settings.statusLine : null
  if (!statusLine || typeof statusLine.command !== 'string' || !statusLine.command.trim()) return null
  return { command: statusLine.command, padding: typeof statusLine.padding === 'number' ? statusLine.padding : null }
}

export const claudeStatusFile = (folder: string): string => join(folder, 'latest.json')

/** Writes the bridge under `folder` and resolves to the env that `claude --settings "$TREEIX_CLAUDE_SETTINGS"` in our terminals needs */
export async function setUpClaudeStatus(folder: string): Promise<() => Promise<Record<string, string>>> {
  const script = join(folder, 'statusline.sh')
  await mkdir(folder, { recursive: true })
  await writeFile(script, bridgeScript(claudeStatusFile(folder)))
  await chmod(script, 0o755)
  return () => sessionEnv(script)
}

async function sessionEnv(script: string): Promise<Record<string, string>> {
  const previous = userStatusLine(await readJsonFile(join(homedir(), '.claude', 'settings.json')))
  const chained = previous && !previous.command.includes(script) ? previous : null
  return {
    TREEIX_CLAUDE_SETTINGS: JSON.stringify({ statusLine: { type: 'command', command: shellQuote(script), padding: chained?.padding ?? 0 } }),
    TREEIX_PREVIOUS_STATUSLINE: chained?.command ?? ''
  }
}
