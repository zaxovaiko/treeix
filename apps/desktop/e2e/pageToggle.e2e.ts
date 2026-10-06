import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a tab shows alone, and its × closes it to an empty state without buttons', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const emptyState = page.getByText('Nothing open')
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)

  await page.locator('[data-tab-close="terminal"]').click()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toBeVisible()
  await expect(page.locator('[data-zone="main"] button:visible')).toHaveCount(0)

  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  await expect(emptyState).toHaveCount(0)
})

test('⇧-click opens up to three pages side by side, the rightmost making room for a fourth', async () => {
  const { page } = launched
  const ids = await page.locator('[data-page-tab]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-page-tab') ?? ''))
  const [first, second, third, fourth] = ['terminal', ...ids.filter((id) => id !== 'terminal')]
  const tab = (id: string) => page.locator(`[data-page-tab="${id}"]`)
  const splits = page.locator('[data-split-pane]:not([data-overlay])')

  await tab(first).click()
  await tab(second).click({ modifiers: ['Shift'] })
  await expect(tab(first)).toHaveAttribute('aria-current', 'page')
  await expect(tab(second)).toHaveAttribute('aria-current', 'page')
  await expect(splits).toHaveCount(1)
  await expect(tab(second).locator('[data-tab-slot="1"]')).toBeVisible()

  await tab(third).click({ modifiers: ['Shift'] })
  await expect(splits).toHaveCount(2)
  await tab(fourth).click({ modifiers: ['Shift'] })
  await expect(splits).toHaveCount(2)
  await expect(tab(third)).not.toHaveAttribute('aria-current', 'page')
  await expect(tab(fourth).locator('[data-tab-slot="2"]')).toBeVisible()

  // ⇧-click on a page in the split takes it out
  await tab(second).click({ modifiers: ['Shift'] })
  await expect(splits).toHaveCount(1)
  await expect(tab(second)).not.toHaveAttribute('aria-current', 'page')

  // Closing the main page hands its place to the one beside it
  await page.locator(`[data-tab-close="${first}"]`).click()
  await expect(splits).toHaveCount(0)
  await expect(tab(fourth)).toHaveAttribute('aria-current', 'page')

  // A plain click shows only that page
  await tab(first).click({ modifiers: ['Shift'] })
  await expect(splits).toHaveCount(1)
  await tab(first).click()
  await expect(splits).toHaveCount(0)
  await expect(tab(fourth)).not.toHaveAttribute('aria-current', 'page')
})

test('the × sits at the end Settings picks', async () => {
  const { page } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const closeAtEnd = (): Promise<boolean> => terminalTab.evaluate((tab) => tab.lastElementChild?.hasAttribute('data-tab-close') ?? false)
  expect(await closeAtEnd()).toBe(true)
  await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('settings') ?? '{}'), tabCloseSide: 'left' })))
  await page.reload()
  await expect(terminalTab).toHaveAttribute('aria-current', 'page')
  expect(await terminalTab.evaluate((tab) => tab.firstElementChild?.hasAttribute('data-tab-close') ?? false)).toBe(true)
})

test('pages side by side belong to the workspace they were opened in', async () => {
  const { page, repo } = launched
  const ids = await page.locator('[data-page-tab]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-page-tab') ?? ''))
  const [first, second] = ['terminal', ...ids.filter((id) => id !== 'terminal')]
  const splits = page.locator('[data-split-pane]:not([data-overlay])')
  await page.evaluate((repoPath) => {
    const workspace = (id: string, name: string) => ({ id, name, color: '#64748b', repoPaths: [repoPath] })
    localStorage.setItem('workspaces', JSON.stringify([workspace('split', 'Split'), workspace('single', 'Single')]))
    localStorage.setItem('workspaces.current', 'split')
    localStorage.setItem('app.overlay', 'false')
  }, repo)
  await page.reload()
  const switchTo = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: 'Run command' }).click()
    await page.getByPlaceholder(/^Search commands/).fill(`Switch to ${name}`)
    await page.keyboard.press('Enter')
  }

  await page.locator(`[data-page-tab="${first}"]`).click()
  await page.locator(`[data-page-tab="${second}"]`).click({ modifiers: ['Shift'] })
  await expect(splits).toHaveCount(1)

  await switchTo('Single')
  await expect(splits).toHaveCount(0)
  await switchTo('Split')
  await expect(splits).toHaveCount(1)
})
