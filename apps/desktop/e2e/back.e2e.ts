import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('the title bar arrows walk back to the AI Hub and the page before it, and forward again', async () => {
  const { page } = launched
  const back = page.getByRole('button', { name: /^Back/ })
  const forward = page.getByRole('button', { name: /^Forward/ })
  const worktreesTab = page.locator('[data-page-tab="worktrees"]')
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const hub = page.locator('[data-overlay]')

  await worktreesTab.click()
  await page.locator('[data-overlay-button]').click()
  await expect(hub).toBeVisible()
  await terminalTab.click()
  await expect(hub).not.toBeVisible()
  await expect(forward).toBeDisabled()

  await back.click()
  await expect(hub).toBeVisible()
  await back.click()
  await expect(hub).not.toBeVisible()
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')

  await forward.click()
  await expect(hub).toBeVisible()
  await forward.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(forward).toBeDisabled()
})
