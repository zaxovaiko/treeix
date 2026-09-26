import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('ctrl+tab cycles the tabs and inactive tabs can show only their icon', async () => {
  const { page } = launched
  // Hovering moves a title into data-tip for the app's own tooltip
  const tab = (name: string) => page.locator(`button[title^="${name}"], button[data-tip^="${name}"]`).first()
  await tab('Worktrees').click()
  await expect(tab('Worktrees')).toHaveClass(/ring-1/)
  await page.keyboard.press('Control+Tab')
  await expect(tab('Worktrees')).not.toHaveClass(/ring-1/)
  await page.keyboard.press('Control+Shift+Tab')
  await expect(tab('Worktrees')).toHaveClass(/ring-1/)

  await page.getByRole('button', { name: 'Show only the active tab name' }).click()
  await expect(tab('Worktrees')).toContainText('Worktrees')
  await expect(tab('Terminal')).not.toContainText('Terminal')
  await page.getByRole('button', { name: 'Show every tab name' }).click()
  await expect(tab('Terminal')).toContainText('Terminal')
})

test('a workspace takes any hex colour or shade and its own avatar text', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByPlaceholder('Select projects or type a name').fill('Blog')
  await page.getByLabel('Avatar text').fill('B!')
  const hex = page.getByLabel('Colour hex')
  await hex.fill('#123456')
  await hex.press('Enter')
  await expect(page.getByRole('button', { name: 'Colour #123456' })).toBeVisible()
  await page.getByRole('button', { name: 'Shade #091a2b' }).click()
  await page.getByRole('button', { name: 'Create workspace' }).click()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('workspaces') ?? '[]'))
  expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Blog', color: '#091a2b', avatarText: 'B!' })]))
  await expect(page.locator('button[title^="Blog"]')).toContainText('B!')
})
