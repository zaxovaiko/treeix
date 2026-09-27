import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

const PAGE = `<!doctype html><title>Agent page</title>
<h1>Checkout</h1>
<label>Email <input id="email"></label>
<select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
<button onclick="document.querySelector('#out').textContent = 'Sent ' + email.value + ' ' + size.value; console.error('clicked'); fetch('/api/order')">Send</button>
<p id="out"></p>`

let launched: Launched
let site: Server
let siteUrl = ''
let mcp: { url: string; token: string }

const rpc = async (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(mcp.url, { method: 'POST', headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })

type ToolResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => ((await (await rpc('tools/call', { name, arguments: args })).json()) as { result: ToolResult }).result
const text = (result: ToolResult): string => result.content.map((part) => part.text ?? '').join('\n')

test.beforeAll(async () => {
  site = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': request.url === '/api/order' ? 'application/json' : 'text/html' })
    response.end(request.url === '/api/order' ? '{"ok":true}' : PAGE)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  siteUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(async () => {
  await launched.close()
  site.close()
})

test('agent sessions get an MCP server that drives the built-in browser', async () => {
  const { page, repo } = launched
  // A session's shell carries the server's address and token
  const envFile = join(dirname(repo), 'mcp.txt')
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  await page.keyboard.type(`printf '%s\\n%s\\n%s' "$TREEIX_MCP_URL" "$TREEIX_MCP_TOKEN" "$TREEIX_CODEX_MCP" > ${envFile}\n`)
  await expect.poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8').includes('http'), { timeout: 10_000 }).toBe(true)
  const [url, token, codex] = readFileSync(envFile, 'utf8').split('\n')
  mcp = { url, token }
  expect(codex).toContain(`url="${url}"`)

  expect((await rpc('ping', {}, { Authorization: 'Bearer nope' })).status).toBe(401)
  expect((await rpc('ping', {}, { Origin: 'https://evil.example' })).status).toBe(401)
  const init = (await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).json()) as { result: { instructions: string } }
  expect(init.result.instructions).toContain('browser_')
  const listed = (await (await rpc('tools/list')).json()) as { result: { tools: { name: string }[] } }
  expect(listed.result.tools.map((tool) => tool.name)).toContain('browser_snapshot')


  // Sessions: the shell above is listed, takes a command and shows its output
  const shell = text(await call('sessions_list')).split('\n').find((line) => line.includes(' shell ')) ?? ''
  expect(shell).toContain('running')
  const session = shell.split(' ')[0]
  await call('session_send', { session, text: 'echo treeix-$((6*7))' })
  await expect.poll(async () => text(await call('session_read', { session })), { timeout: 5000 }).toContain('treeix-42')

  const opened = text(await call('browser_navigate', { url: siteUrl }))
  const tab = opened.match(/Opened tab (\S+):/)?.[1] ?? ''
  expect(opened).toContain('Agent page')
  // The user sees it: the page is a tab of the built-in browser
  await expect(page.locator(`webview[src="${siteUrl}"]`)).toHaveCount(1)
  expect(text(await call('browser_tabs'))).toContain(tab)

  const snapshot = text(await call('browser_snapshot', { tab }))
  const ref = (role: string, name: string): number => Number(snapshot.match(new RegExp(`${role} "${name}".*\\[ref=(\\d+)\\]`))?.[1])
  expect(snapshot).toContain('heading "Checkout" level=1')

  await call('browser_type', { tab, ref: ref('textbox', 'Email'), text: 'a@b.c' })
  await call('browser_type', { tab, ref: ref('combobox', 'Size'), text: 'Large' })
  // The page isn't focused, so the key goes in through the page itself
  await call('browser_press', { tab, key: 'Backspace' })
  expect(text(await call('browser_evaluate', { tab, expression: 'email.value' }))).toBe('"a@b."')
  await call('browser_press', { tab, key: 'c' })
  expect(text(await call('browser_evaluate', { tab, expression: 'email.value' }))).toBe('"a@b.c"')
  await call('browser_click', { tab, ref: ref('button', 'Send') })
  expect(text(await call('browser_wait_for', { tab, text: 'Sent a@b.c l' }))).toContain('Found')
  expect(text(await call('browser_evaluate', { tab, expression: 'document.querySelector("#out").textContent' }))).toBe('"Sent a@b.c l"')
  expect(text(await call('browser_console', { tab }))).toContain('[error] clicked')
  await expect.poll(async () => text(await call('browser_network', { tab, filter: '/api/order' }))).toContain('GET 200')
  const requestId = text(await call('browser_network', { tab, filter: '/api/order' })).split(' ')[0]
  expect(text(await call('browser_network', { tab, id: requestId }))).toContain('{"ok":true}')

  const shot = await call('browser_screenshot', { tab })
  expect(shot.content[0]).toMatchObject({ type: 'image' })
  expect((await call('browser_navigate', { url: 'file:///etc/passwd' })).isError).toBe(true)

  await call('browser_close', { tab })
  await expect(page.locator(`webview[src="${siteUrl}"]`)).toHaveCount(0)
})
