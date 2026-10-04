import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a left tab shows in the left pane and hides on a second click, leaving an empty state without buttons', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const emptyState = page.getByText('Nothing open')
  // The AI Hub, where the app opens, hidden leaves both panes empty
  await page.locator('[data-page-tab="hub"]').click()
  await expect(emptyState).toBeVisible()
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)

  await terminalTab.click()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toBeVisible()
  await expect(page.locator('[data-zone="main"] button:visible')).toHaveCount(0)

  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)
})

test('a second tab opens beside the first, and each hides on a second click', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const worktreesTab = page.locator('[data-page-tab="worktrees"]')
  const rightPane = page.locator('[data-split-pane]')
  const emptyState = page.getByText('Nothing open')

  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await worktreesTab.click()
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(rightPane).toBeVisible()

  // The right pane takes the whole window while the left one is hidden
  await terminalTab.click()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')
  await expect(rightPane).toBeVisible()
  await expect(emptyState).toBeHidden()

  await worktreesTab.click()
  await expect(worktreesTab).not.toHaveAttribute('aria-current', 'page')
  await expect(rightPane).toHaveCount(0)
  await expect(emptyState).toBeVisible()

  // With both hidden the next tab fills the left pane
  await worktreesTab.click()
  await expect(worktreesTab).toHaveAttribute('aria-current', 'page')
  await expect(rightPane).toHaveCount(0)
})
