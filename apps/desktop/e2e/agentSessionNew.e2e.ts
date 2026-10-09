import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

type ClaudeMcp = { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }

test('an agent starts a session through session_new and finds it in sessions_list', async () => {
  const { page, repo } = launched
  const envFile = join(dirname(repo), 'claude-mcp.json')
  const startedFile = join(dirname(repo), 'started.txt')
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  await page.keyboard.type(`printf '%s' "$TREEIX_CLAUDE_MCP" > ${envFile}\n`)
  await expect.poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8').includes('http'), { timeout: 10_000 }).toBe(true)
  const [server] = Object.values((JSON.parse(readFileSync(envFile, 'utf8')) as ClaudeMcp).mcpServers)

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return JSON.stringify(await response.json())
  }

  expect(await call('session_new', { folder: repo, kind: 'nope' })).toContain('No agent nope')
  expect(await call('session_new', { folder: join(repo, 'missing') })).toContain('No folder')

  const started = await call('session_new', { folder: repo, kind: 'shell', prompt: `printf ok > ${startedFile}` })
  const id = /Started (\S+) \(shell\)/.exec(started)?.[1]
  expect(id).toBeTruthy()
  await expect.poll(() => existsSync(startedFile), { timeout: 10_000 }).toBe(true)
  expect(await call('sessions_list', {})).toContain(String(id))
})
