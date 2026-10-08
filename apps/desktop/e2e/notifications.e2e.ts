import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a session that needs the user lights the AI Hub button, and a peek at it puts the light out', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  await terminalTab.click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  // Reports what an agent's hook would, once the user is on another page
  await page.keyboard.type('sleep 3 && printf input > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION_ID"\n')
  await page.locator('[data-page-tab="worktrees"]').click({ modifiers: ['Shift'] })
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')

  const hubButton = page.locator('[data-overlay-button]')
  const dot = hubButton.locator('[data-hub-attention]')
  await expect(dot).toBeVisible({ timeout: 15_000 })
  await hubButton.hover()
  await expect(page.locator('[data-overlay-peek]')).toBeVisible()
  await expect(dot).toHaveCount(0)
})
