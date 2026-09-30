import { expect, test } from 'bun:test'
import { agentActivity } from './activity'

test('a question wins, then an unseen finished turn, then work, then an open agent', () => {
  expect(agentActivity(['running', 'done', 'input'])).toBe('input')
  expect(agentActivity(['running', 'done'])).toBe('done')
  expect(agentActivity(['idle', 'running'])).toBe('running')
  expect(agentActivity(['exited', 'idle'])).toBe('ready')
  expect(agentActivity(['exited', 'dormant'])).toBe('none')
  expect(agentActivity([])).toBe('none')
})
