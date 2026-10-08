import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched
let site: Server
let siteUrl = ''

test.beforeAll(async () => {
  site = createServer((_, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Agent page</title>'))
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  siteUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(async () => {
  await launched.close()
  site.close()
})

type ClaudeMcp = { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }

test("an agent's browser tab opens in its session's workspace, not the one on screen", async () => {
  const { page, repo } = launched
  const envFile = join(dirname(repo), 'claude-mcp.json')
  await page
    .getByRole('button', { name: 'Terminal', exact: true })
    .first()
    .click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  await page.keyboard.type(`printf '%s' "$TREEIX_CLAUDE_MCP" > ${envFile}\n`)
  await expect.poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8').includes('http'), { timeout: 10_000 }).toBe(true)
  const [server] = Object.values((JSON.parse(readFileSync(envFile, 'utf8')) as ClaudeMcp).mcpServers)
  const sessionWorkspace = server.headers['x-treeix-workspace']
  expect(sessionWorkspace).toBeTruthy()

  await page.locator('[data-workspace-switcher]').click()
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByPlaceholder('Select projects or type a name').fill('Other')
  await page.getByRole('button', { name: 'Create workspace' }).click()
  const shown = await page.evaluate(() => localStorage.getItem('workspaces.current'))
  expect(shown).not.toBe(sessionWorkspace)

  const response = await fetch(server.url, {
    method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: siteUrl } } })
  })
  expect(JSON.stringify(await response.json())).toContain('Opened tab')

  const urlsOf = async (workspace: string | null | undefined): Promise<string[]> =>
    page.evaluate((key) => (JSON.parse(localStorage.getItem('browser.tabs') ?? '{}') as Record<string, { urls: string[] }>)[key ?? '']?.urls ?? [], workspace)
  expect(await urlsOf(sessionWorkspace)).toContain(siteUrl)
  expect(await urlsOf(shown)).not.toContain(siteUrl)
  expect(await page.evaluate(() => localStorage.getItem('workspaces.current'))).toBe(shown)
})
