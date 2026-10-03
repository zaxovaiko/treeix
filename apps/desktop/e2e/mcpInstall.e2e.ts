import { expect, test } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched
// Stand-in claude and codex CLIs; claude writes its config the way the real one does
const stubs = mkdtempSync(join(tmpdir(), 'treeix-agents-'))
const originalPath = process.env.PATH
test.beforeAll(async () => {
  writeFileSync(
    join(stubs, 'claude'),
    `#!/bin/sh\ncase "$2" in add) printf '{"mcpServers":{"treeix":{"type":"http","url":"%s","headers":{"Authorization":"%s"}}}}' "$8" "\${10#Authorization: }" > "$HOME/.claude.json" ;; esac\n`
  )
  writeFileSync(join(stubs, 'codex'), '#!/bin/sh\necho codex 1.0\n')
  chmodSync(join(stubs, 'claude'), 0o755)
  chmodSync(join(stubs, 'codex'), 0o755)
  process.env.PATH = `${stubs}:${originalPath}`
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(async () => {
  await launched.close()
  process.env.PATH = originalPath
  rmSync(stubs, { recursive: true, force: true })
})

test('the plug button sets up the Treeix MCP in Claude Code and Codex, keeping the rest of their config', async () => {
  const { page, repo } = launched
  const home = dirname(dirname(repo))
  // Both agents have run here before
  writeFileSync(join(home, '.claude.json'), '{"mcpServers":{}}')
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.treeix]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n')
  await page.reload()

  await page.getByRole('button', { name: 'Set up the Treeix MCP in Claude Code and Codex (outdated)' }).click()
  // Set up, it leaves the title bar; Settings keeps the button
  await expect(page.getByRole('button', { name: /^Set up the Treeix MCP/ })).toBeHidden({ timeout: 10_000 })

  const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { mcpServers: { treeix: { url: string; headers: { Authorization: string } } } }
  const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  expect(codex).toContain('model = "gpt-5"')
  expect(codex).toContain('[mcp_servers.other]\ncommand = "other"')
  expect(codex).not.toContain('command = "old"')
  expect(codex).toContain(`url = "${claude.mcpServers.treeix.url}"`)
  expect(codex).toContain(`Authorization = "${claude.mcpServers.treeix.headers.Authorization}"`)

  // The server answers what the agents were given
  const answer = await fetch(claude.mcpServers.treeix.url, {
    method: 'POST',
    headers: { Authorization: claude.mcpServers.treeix.headers.Authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })
  expect(answer.status).toBe(200)
})
