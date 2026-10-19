import { expect, test } from '@playwright/test'
import { FAKE_CHAT, launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, FAKE_CHAT)
})
test.afterAll(() => launched.close())

test("a chat's terminal button opens a shell in its folder, as tabs that split and close with keys", async () => {
  const { page, app } = launched
  await page.getByPlaceholder('Message Fake').fill('hello')
  const send = page.getByRole('button', { name: 'Send' })
  await expect(send).toBeEnabled({ timeout: 20_000 })
  await send.click()
  const terminal = page.getByRole('button', { name: /^Terminal/ })

  const panel = page.locator('aside:has([role=tablist])')
  const tabs = panel.getByRole('tab')
  await terminal.click()
  await expect(panel.locator('.xterm')).toBeVisible({ timeout: 15_000 })
  await expect(tabs).toHaveCount(1)
  // The chat itself stays out of the terminal panel
  await expect(tabs.first()).not.toContainText('hello')

  // Showing it again reuses the shell
  await terminal.click()
  await expect(panel).toBeHidden()
  await terminal.click()
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
