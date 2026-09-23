import { expect, test } from 'bun:test'
import { withStatusHooks } from './hooks'

test('withStatusHooks keeps other settings and reports input on notifications', () => {
  const settings = JSON.parse(withStatusHooks(JSON.stringify({ statusLine: { type: 'command', command: 'x' } })))
  expect(settings.statusLine.command).toBe('x')
  expect(settings.hooks.Notification[0].hooks[0].command).toContain("printf input")
  expect(settings.hooks.Stop[0].hooks[0].command).toContain("printf working")
  expect(JSON.parse(withStatusHooks('not json')).hooks.PreToolUse[0].matcher).toBe('*')
})
