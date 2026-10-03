import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a tab icon picked in Appearance settings shows in the title bar and resets to its own', async () => {
  const { page } = launched
  const worktreesTabIcon = page.locator('[data-page-tab="worktrees"] svg')
  await expect(worktreesTabIcon).toHaveAttribute('data-icon', 'branch')

  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('button', { name: 'Worktrees icon' }).click()
  await page.getByRole('menu', { name: 'Worktrees icon' }).getByRole('menuitemradio', { name: 'folder', exact: true }).click()

  await expect(worktreesTabIcon).toHaveAttribute('data-icon', 'folder')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}'))).toMatchObject({ tabIcons: { worktrees: 'folder' } })

  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(worktreesTabIcon).toHaveAttribute('data-icon', 'branch')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}').tabIcons)).toEqual({})
})
