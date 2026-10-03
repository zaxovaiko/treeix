import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a page tab clicked while open hides it behind an empty state, and a second click or its button shows it again', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const emptyState = page.getByText('No tab open')
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)

  await terminalTab.click()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toBeVisible()

  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)

  await terminalTab.click()
  await page.getByRole('button', { name: 'Show Terminal', exact: true }).click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')

  // Another tab while one is hidden just shows that one
  const worktreesTab = page.locator('[data-page-tab="worktrees"]')
  await terminalTab.click()
  await worktreesTab.click()
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)
})
