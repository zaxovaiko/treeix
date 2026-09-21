import { expect, test } from 'bun:test'
import { BUILTIN_AGENTS, viewFor } from './agents'

test('presets carry ACP chat commands and Gemini is built in', () => {
  expect(BUILTIN_AGENTS.claude.chat).toEqual({ adapter: 'acp', command: 'npx -y @agentclientprotocol/claude-agent-acp' })
  expect(BUILTIN_AGENTS.codex.chat).toEqual({ adapter: 'acp', command: 'npx -y @zed-industries/codex-acp' })
  expect(BUILTIN_AGENTS.gemini.chat).toEqual({ adapter: 'acp', command: 'gemini --experimental-acp' })
  expect('chat' in BUILTIN_AGENTS.shell).toBe(false)
})

test('viewFor defaults to terminal and never picks chat for an agent without a chat command', () => {
  expect(viewFor(BUILTIN_AGENTS.claude, {})).toBe('terminal')
  expect(viewFor(BUILTIN_AGENTS.claude, { claude: 'chat' })).toBe('chat')
  expect(viewFor(BUILTIN_AGENTS.shell, { shell: 'chat' })).toBe('terminal')
})
