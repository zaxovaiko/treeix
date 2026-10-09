import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('the title bar arrows walk back to the page before and forward again, and so do their keys', async () => {
  const { page } = launched
  const back = page.getByRole('button', { name: /^Back/ })
  const forward = page.getByRole('button', { name: /^Forward/ })
  const worktreesTab = page.locator('[data-page-tab="worktrees"]')
  const terminalTab = page.locator('[data-page-tab="terminal"]')

  await worktreesTab.click()
  await terminalTab.click()
  await expect(forward).toBeDisabled()

  await back.click()
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Shift+Minus')
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(forward).toBeDisabled()

  await page.keyboard.press('Control+Minus')
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')
  await forward.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
})
