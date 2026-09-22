import { expect, test } from 'bun:test'
import { BUILTIN_AGENTS, viewFor } from './agents'

globalThis.localStorage ??= { getItem: () => null, setItem: () => undefined } as unknown as Storage

const setAgents = async (customAgents: unknown[]): Promise<void> => {
  const { parseCustomAgents, updateSettings } = await import('./settings')
  updateSettings({ customAgents: parseCustomAgents(customAgents) })
}

test('presets carry ACP chat commands', () => {
  expect(BUILTIN_AGENTS.claude.chat).toEqual({ adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp@0.79.0' })
  expect(BUILTIN_AGENTS.codex.chat).toEqual({ adapter: 'acp', command: 'npx -y @zed-industries/codex-acp@0.16.0' })
  expect('chat' in BUILTIN_AGENTS.shell).toBe(false)
})

test('viewFor defaults to terminal and never picks chat for an agent without a chat command', () => {
  expect(viewFor(BUILTIN_AGENTS.claude, {})).toBe('terminal')
  expect(viewFor(BUILTIN_AGENTS.claude, { claude: 'chat' })).toBe('chat')
  expect(viewFor(BUILTIN_AGENTS.shell, { shell: 'chat' })).toBe('terminal')
})

test('built-in commands keep the behaviour they had when they were hardcoded', async () => {
  await setAgents([])
  const { BUILTIN_AGENTS, startCommand, resumeCommandFor } = await import('./agents')
  const claude = BUILTIN_AGENTS.claude
  expect(startCommand(claude)).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS"')
  expect(startCommand(claude, "'fix the test'", 'abc')).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS" --session-id abc \'fix the test\'')
  expect(resumeCommandFor(claude, 'abc')).toContain('~/.claude/projects/*/abc.jsonl')
  expect(resumeCommandFor(claude, 'abc')).toContain('--resume abc')
  expect(resumeCommandFor(claude, null)).toBe('claude --settings "$TREEIX_CLAUDE_SETTINGS"')
  expect(resumeCommandFor(BUILTIN_AGENTS.codex, null)).toBe('codex resume --last')
})

test('a shell session runs the prompt as its command line, or nothing at all', async () => {
  await setAgents([])
  const { BUILTIN_AGENTS, startCommand, resumeCommandFor } = await import('./agents')
  expect(startCommand(BUILTIN_AGENTS.shell)).toBeUndefined()
  expect(startCommand(BUILTIN_AGENTS.shell, 'bun run dev')).toBe('bun run dev')
  expect(resumeCommandFor(BUILTIN_AGENTS.shell, null)).toBeUndefined()
})

test('a custom agent gets its prompt behind the flag it declares', async () => {
  const aider = { id: 'aider', label: 'Aider', mark: 'A', color: '#fff', command: 'aider', promptFlag: '--message', agent: true }
  const resumable = { id: 'resumable', label: 'Resumable', mark: 'R', color: '#fff', command: 'resumable', resumeCommand: 'resumable --resume {id}', agent: true }
  await setAgents([aider, resumable])
  const { getAgents, getAgent, isAgent, startCommand, resumeCommandFor } = await import('./agents')
  expect(getAgents().map((entry) => entry.id)).toEqual(['claude', 'codex', 'shell', 'aider', 'resumable'])
  expect(startCommand(getAgent('aider')!, "'add a test'")).toBe("aider --message 'add a test'")
  expect(resumeCommandFor(getAgent('aider')!, 'abc')).toBe('aider')
  expect(resumeCommandFor(getAgent('resumable')!, 'abc')).toBe('resumable --resume abc')
  expect(resumeCommandFor(getAgent('resumable')!, null)).toBe('resumable')
  expect(isAgent('aider')).toBe(true)
  expect(isAgent('shell')).toBe(false)
})

test('a custom agent replaces the built-in it shares an id with', async () => {
  await setAgents([{ id: 'claude', label: 'Claude', mark: '✳', color: '#fff', command: '/opt/claude', agent: true }])
  const { getAgents, getAgent } = await import('./agents')
  expect(getAgents()).toHaveLength(3)
  expect(getAgent('claude')?.command).toBe('/opt/claude')
})

test('a malformed stored agent is dropped and missing fields get defaults', async () => {
  await setAgents([null, 'aider', { label: 'No id' }, { id: 'bare' }])
  const { getAgents, getAgent } = await import('./agents')
  expect(getAgents().map((entry) => entry.id)).toEqual(['claude', 'codex', 'shell', 'bare'])
  expect(getAgent('bare')).toMatchObject({ label: 'bare', mark: '●', command: null, agent: true })
})

test('getAgents returns the identical array while customAgents is unchanged, and a fresh one once it changes', async () => {
  await setAgents([])
  const { getAgents } = await import('./agents')
  const { updateSettings, parseCustomAgents } = await import('./settings')
  const first = getAgents()
  expect(getAgents()).toBe(first)
  updateSettings({ customAgents: parseCustomAgents([{ id: 'aider', label: 'Aider', mark: 'A', color: '#fff', command: 'aider', agent: true }]) })
  const second = getAgents()
  expect(second).not.toBe(first)
  expect(getAgents()).toBe(second)
})

test('an agent that is gone falls back to a neutral row instead of crashing', async () => {
  await setAgents([])
  const { getAgent, agentOr, isAgent } = await import('./agents')
  expect(getAgent('deleted')).toBeUndefined()
  expect(agentOr('deleted')).toMatchObject({ id: 'deleted', label: 'deleted', command: null, agent: false })
  expect(isAgent('deleted')).toBe(false)
})
