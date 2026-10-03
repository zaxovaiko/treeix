import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withStatusHooks } from './hooks'

test('withStatusHooks keeps other settings and reports input on notifications', () => {
  const settings = JSON.parse(withStatusHooks(JSON.stringify({ statusLine: { type: 'command', command: 'x' } })))
  expect(settings.statusLine.command).toBe('x')
  expect(settings.hooks.Notification[0].hooks[0].command).toContain('printf input')
  expect(settings.hooks.Notification[0].matcher).not.toContain('idle_prompt')
  expect(settings.hooks.Stop[0].hooks[0].command).toContain('printf done')
  expect(JSON.parse(withStatusHooks('not json')).hooks.PreToolUse[0].matcher).toBe('*')
})

test('a question or a plan to approve reports input, other tools report work', () => {
  const command: string = JSON.parse(withStatusHooks('{}')).hooks.PreToolUse[0].hooks[0].command
  const folder = mkdtempSync(join(tmpdir(), 'treeix-hook-'))
  const run = (input: string): string => {
    spawnSync('sh', ['-c', command], { input, env: { ...process.env, TREEIX_SESSION_ID: 's', TREEIX_AGENT_STATUS: folder } })
    return readFileSync(join(folder, 's'), 'utf8')
  }
  expect(run('{"tool_name":"AskUserQuestion","tool_input":{}}')).toBe('input')
  expect(run('{"session_id": "x", "tool_name": "ExitPlanMode"}')).toBe('input')
  expect(run('{"tool_name":"Bash","tool_input":{"command":"echo AskUserQuestion"}}')).toBe('working')
  rmSync(folder, { recursive: true })
})
