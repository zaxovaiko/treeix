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
  await expect(tab('Worktrees')).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Tab')
  await expect(tab('Worktrees')).not.toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(tab('Worktrees')).toHaveAttribute('aria-current', 'page')

  // Compact is the default: tabs show only their icon, the active one too
  await expect(tab('Worktrees')).not.toContainText('Worktrees')
  await page.getByRole('button', { name: 'Show tab names' }).click()
  await expect(tab('Worktrees')).toContainText('Worktrees')
  await expect(tab('Terminal')).toContainText('Terminal')
  await page.getByRole('button', { name: 'Hide tab names' }).click()
  await expect(tab('Terminal')).not.toContainText('Terminal')
})

test('a workspace takes any hex colour or shade and an icon', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByPlaceholder('Select projects or type a name').fill('Blog')
  await page.getByRole('button', { name: 'Icon coffee' }).click()
  const hex = page.getByLabel('Colour hex')
  await hex.fill('#123456')
  await hex.press('Enter')
  await expect(page.getByRole('button', { name: 'Colour #123456' })).toBeVisible()
  await page.getByRole('button', { name: 'Shade #091a2b' }).click()
  await page.getByRole('button', { name: 'Create workspace' }).click()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('workspaces') ?? '[]'))
  expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Blog', color: '#091a2b', icon: 'coffee' })]))
  await expect(page.locator('[data-app-sidebar] [data-icon="coffee"]')).toBeVisible()
})

test('the sidebar hides from its own header and comes back with its key', async () => {
  const { page } = launched
  const sidebar = page.locator('[data-app-sidebar]')
  await expect(sidebar).toBeVisible()
  await page.getByRole('button', { name: /^Sidebar/ }).click()
  await expect(sidebar).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+b')
  await expect(sidebar).toBeVisible()
})

test('settings open as a title bar tab its × closes', async () => {
  const { page } = launched
  await page.getByRole('button', { name: /^Settings/ }).click()
  const tab = page.locator('[data-page-tab="settings"]')
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await tab.getByRole('button', { name: 'Close settings' }).click()
  await expect(tab).toHaveCount(0)
})
