import { expect, test } from 'bun:test'
import { markedPath, withoutAgentVariables } from './env'

test('withoutAgentVariables drops inherited agent session markers', () => {
  const env = { PATH: '/bin', HOME: '/Users/me', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', AI_AGENT: 'x', ANTHROPIC_API_KEY_HELPER: 'keep' }
  expect(withoutAgentVariables(env)).toEqual({ PATH: '/bin', HOME: '/Users/me', ANTHROPIC_API_KEY_HELPER: 'keep' })
})

test('markedPath ignores what rc files print around the marked PATH', () => {
  expect(markedPath('welcome!\n__TREEIX_PATH__/a/bin:/usr/bin__TREEIX_PATH__\nbye')).toBe('/a/bin:/usr/bin')
  expect(markedPath('no markers here')).toBeNull()
})
