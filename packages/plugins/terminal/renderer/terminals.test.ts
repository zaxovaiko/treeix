import { expect, test } from 'bun:test'
import { BUILTIN_AGENTS } from '@treeix/app/agents'
import { isDefaultChatTitle, newTabEntries, parseMeta, unarchived } from './sessionMeta'

const saved = { worktreePath: '/repo', kind: 'claude', title: 'Claude', startedAt: 1, workspaceId: 'w', agentSessionId: 'abc' }

test('parseMeta reads sessions saved before chats as terminals and keeps chats', () => {
  expect(parseMeta(saved)?.view).toBe('terminal')
  expect(parseMeta({ ...saved, view: 'chat' })?.view).toBe('chat')
  expect(parseMeta({ ...saved, view: 'nonsense' })?.view).toBe('terminal')
  expect(parseMeta({ ...saved, id: 'x' })).toMatchObject({ id: 'x' })
  expect(parseMeta({ title: 'no folder' })).toBeNull()
  expect(parseMeta(null)).toBeNull()
})

test('unarchived hides archived history entries', () => {
  expect(unarchived([{ id: 'a' }, { id: 'b', archived: true }, { id: 'c', archived: false }]).map((entry) => entry.id)).toEqual(['a', 'c'])
})

test('newTabEntries lists each agent in its default view, then the other view when it has chat', () => {
  const agents = [BUILTIN_AGENTS.claude, BUILTIN_AGENTS.shell]
  expect(newTabEntries(agents, {})).toEqual([
    { agent: 'claude', view: 'terminal', label: 'Claude', secondary: false },
    { agent: 'claude', view: 'chat', label: 'Claude chat', secondary: true },
    { agent: 'shell', view: 'terminal', label: 'Shell', secondary: false }
  ])
  expect(newTabEntries(agents, { claude: 'chat' }).slice(0, 2)).toEqual([
    { agent: 'claude', view: 'chat', label: 'Claude', secondary: false },
    { agent: 'claude', view: 'terminal', label: 'Claude in terminal', secondary: true }
  ])
})

test('isDefaultChatTitle matches only the titles new chats get', () => {
  expect(isDefaultChatTitle('New chat')).toBe(true)
  expect(isDefaultChatTitle('New chat 3')).toBe(true)
  expect(isDefaultChatTitle('New chat about auth')).toBe(false)
  expect(isDefaultChatTitle('Fix the login bug')).toBe(false)
})
