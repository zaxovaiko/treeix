import { expect, test } from 'bun:test'
import { agentState, agentStatus } from './agentStatus'

test('hooks decide for Claude, even before the first one fires', () => {
  expect(agentState('working', true, '')).toBe('running')
  expect(agentState('input', true, '')).toBe('input')
  expect(agentState('done', true, 'esc to interrupt')).toBe('idle')
  expect(agentState(undefined, true, 'Do you want to proceed?')).toBe('idle')
})

test('agents without hooks are read off the screen', () => {
  expect(agentState(undefined, false, '• Working (3s • esc to interrupt)')).toBe('running')
  expect(agentState(undefined, false, 'Would you like to run the following command?')).toBe('input')
  expect(agentState(undefined, false, '› ')).toBe('idle')
})

test('a finished turn stays unseen until the session shows', () => {
  expect(agentStatus('running', 'idle', false, false)).toBe('done')
  expect(agentStatus('idle', 'idle', true, false)).toBe('done')
  expect(agentStatus('done', 'idle', false, false)).toBe('done')
  expect(agentStatus('done', 'idle', false, true)).toBe('idle')
  expect(agentStatus('running', 'idle', true, true)).toBe('idle')
  expect(agentStatus('idle', 'idle', false, false)).toBe('idle')
  expect(agentStatus('done', 'running', false, false)).toBe('running')
})
