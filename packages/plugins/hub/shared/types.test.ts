import { expect, test } from 'bun:test'
import { commandItems, isHubAgent } from './types'

const agent = {
  id: 'a',
  name: 'Reviewer',
  icon: 'R',
  avatar: null,
  color: '#4f5ff0',
  runtime: { kind: 'agent', agent: 'claude' },
  model: 'opus',
  mode: null,
  instructions: '',
  folder: null,
  updatedAt: 1
}

test('a stored agent passes, one from an older or broken file does not', () => {
  expect(isHubAgent(agent)).toBe(true)
  expect(isHubAgent({ ...agent, model: 3 })).toBe(false)
  expect(isHubAgent({ ...agent, runtime: { kind: 'api', baseUrl: 'http://localhost:11434/v1' } })).toBe(true)
  expect(isHubAgent({ ...agent, runtime: { kind: 'api' } })).toBe(false)
  const { folder: _, ...missing } = agent
  expect(isHubAgent(missing)).toBe(false)
})

test('an alien is one with renders, and more folders are paths', () => {
  expect(isHubAgent({ ...agent, alien: 'codex', directories: ['/repo'] })).toBe(true)
  expect(isHubAgent({ ...agent, alien: 'robot' })).toBe(false)
  expect(isHubAgent({ ...agent, directories: '/repo' })).toBe(false)
})

test('schedules are optional and need a valid crontab line', () => {
  const schedule = { id: 's', cron: '0 9 * * 1', prompt: 'News of the week', notify: true, enabled: true }
  expect(isHubAgent({ ...agent, schedules: [schedule] })).toBe(true)
  expect(isHubAgent({ ...agent, schedules: [{ ...schedule, cron: 'every monday' }] })).toBe(false)
})

test('a command schedule has a string command and a whole-minute timeout', () => {
  const schedule = { id: 's', cron: '*/2 * * * *', prompt: 'Work on {{input}}', notify: true, enabled: true, command: 'node poll.mjs', timeoutMin: 180 }
  expect(isHubAgent({ ...agent, schedules: [schedule] })).toBe(true)
  expect(isHubAgent({ ...agent, schedules: [{ ...schedule, command: 1 }] })).toBe(false)
  expect(isHubAgent({ ...agent, schedules: [{ ...schedule, timeoutMin: 0 }] })).toBe(false)
  expect(isHubAgent({ ...agent, schedules: [{ ...schedule, timeoutMin: 1.5 }] })).toBe(false)
})

test("each line a command prints is one run's input and title", () => {
  expect(commandItems('jira:BF-1\tFix the deposit dialog\n\n  \nnotion:abc\n')).toEqual([
    { input: 'jira:BF-1', title: 'jira:BF-1 Fix the deposit dialog' },
    { input: 'notion:abc', title: 'notion:abc' }
  ])
  expect(commandItems('')).toEqual([])
})
