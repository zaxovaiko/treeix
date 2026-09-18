import { expect, test } from 'bun:test'
import { withoutAgentVariables } from './env'

test('withoutAgentVariables drops inherited agent session markers', () => {
  const env = { PATH: '/bin', HOME: '/Users/me', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', AI_AGENT: 'x', ANTHROPIC_API_KEY_HELPER: 'keep' }
  expect(withoutAgentVariables(env)).toEqual({ PATH: '/bin', HOME: '/Users/me', ANTHROPIC_API_KEY_HELPER: 'keep' })
})
