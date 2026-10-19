import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let home: string
let app: ElectronApplication
let page: Page

const fake = {
  id: 'fake',
  label: 'Fake',
  mark: 'F',
  color: '#888888',
  command: null,
  agent: true,
  chat: { adapter: 'acp', command: `"${process.execPath}" "${join(__dirname, 'fakeAcpAgent.mjs')}"` }
}

test.beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-e2e-')))
  app = await electron.launch({
    args: [resolve(__dirname, '..'), '-ApplePersistenceIgnoreState', 'YES'],
    env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data'), TREEIX_HEADLESS: '1' }
  })
  page = await app.firstWindow()
  await page.evaluate((settings) => localStorage.setItem('settings', settings), JSON.stringify({ customAgents: [fake], chatAgent: 'fake' }))
  await page.reload()
})
test.afterAll(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
})

test("a chat's terminal button opens a shell in its folder, as tabs that split and close with keys", async () => {
  await page.getByPlaceholder('Message Fake').fill('hello')
  const send = page.getByRole('button', { name: 'Send' })
  await expect(send).toBeEnabled({ timeout: 20_000 })
  await send.click()

  const panel = page.locator('aside:has([role=tablist])')
  const tabs = panel.getByRole('tab')
  await page.getByRole('button', { name: 'Show terminal' }).click()
  await expect(panel.locator('.xterm')).toBeVisible({ timeout: 15_000 })
  await expect(tabs).toHaveCount(1)
  // The chat itself stays out of the terminal panel
  await expect(tabs.first()).not.toContainText('hello')

  // Showing it again reuses the shell
  await page.getByRole('button', { name: 'Show terminal' }).click()
  await expect(tabs).toHaveCount(1)

  await panel.locator('.xterm').first().click()
  await page.keyboard.press('Meta+Shift+D')
  await expect(panel.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
  await expect(tabs).toHaveCount(2)

  // The narrow panel has room below, not beside
  await panel.getByRole('button', { name: 'Split down' }).click()
  await expect(panel.locator('.xterm')).toHaveCount(3, { timeout: 15_000 })

  // ⌘W comes from the menu, so the test sends what the menu would
  await panel.locator('.xterm').last().click()
  page.once('dialog', (dialog) => void dialog.accept())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('close-shortcut'))
  await expect(tabs).toHaveCount(2)

  await tabs.first().click()
  await tabs
    .first()
    .getByRole('button', { name: /^Close / })
    .click()
  await expect(tabs).toHaveCount(1)
})
