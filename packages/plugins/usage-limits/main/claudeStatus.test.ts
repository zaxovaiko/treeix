import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridgeScript, userStatusLine } from './claudeStatus'

test('userStatusLine picks the command status line only', () => {
  expect(userStatusLine({ statusLine: { type: 'command', command: 'bunx ccstatusline', padding: 2 } })).toEqual({ command: 'bunx ccstatusline', padding: 2 })
  expect(userStatusLine({ statusLine: { command: '  ' } })).toBeNull()
  expect(userStatusLine(null)).toBeNull()
})

test('bridge keeps inputs with rate limits and still runs the previous status line', () => {
  const folder = mkdtempSync(join(tmpdir(), "treeix bridge's "))
  const statusFile = join(folder, 'latest.json')
  const script = join(folder, 'statusline.sh')
  writeFileSync(script, bridgeScript(statusFile))
  const run = (input: string, previous: string): string =>
    execFileSync('sh', [script], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TREEIX_PREVIOUS_STATUSLINE: previous } })

  expect(run('{"model":{}}', '')).toBe('')
  expect(existsSync(statusFile)).toBe(false)

  const withLimits = '{"rate_limits":{"five_hour":{"used_percentage":8}}}'
  expect(run(withLimits, 'cat; echo " shown"')).toBe(`${withLimits} shown\n`)
  expect(readFileSync(statusFile, 'utf8')).toBe(withLimits)
})
