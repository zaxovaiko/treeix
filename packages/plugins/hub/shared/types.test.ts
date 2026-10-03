import { expect, test } from 'bun:test'
import { isHubAgent } from './types'

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
