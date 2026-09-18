// Set when this app is itself launched from an agent (e.g. `bun run dev` inside Claude Code).
// Passing them on makes `claude` in our terminals think it is a nested child session.
const AGENT_VARIABLE = /^(CLAUDE|ANTHROPIC_BASE_URL$|AI_AGENT$|MCP_|CODEX_)/

export function withoutAgentVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !AGENT_VARIABLE.test(entry[0]))
  )
}
