import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a session that needs the user lands in the notification center, and opening it shows the session', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  await terminalTab.click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  // Reports what an agent's hook would, once the user is on another page
  await page.keyboard.type('sleep 3 && printf input > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION_ID"\n')
  await page.locator('[data-page-tab="worktrees"]').click()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')

  const bell = page.getByRole('button', { name: 'Notifications', exact: true })
  await expect(bell).toContainText('1', { timeout: 15_000 })
  await bell.click()
  await page.getByRole('button', { name: /needs you/ }).click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.xterm').first()).toBeVisible()
  // Read once the list was open
  await expect(bell).not.toContainText('1')

  await bell.click()
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByText('No notifications')).toBeVisible()
})
