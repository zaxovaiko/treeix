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
  await tab('Worktrees').click({ modifiers: ['Shift'] })
  await expect(tab('Worktrees')).toHaveClass(/text-primary/)
  await page.keyboard.press('Control+Tab')
  await expect(tab('Worktrees')).not.toHaveClass(/text-primary/)
  await page.keyboard.press('Control+Shift+Tab')
  await expect(tab('Worktrees')).toHaveClass(/text-primary/)

  // Compact is the default: tabs show only their icon, the active one too
  await expect(tab('Worktrees')).not.toContainText('Worktrees')
  await page.getByRole('button', { name: 'Show tab names' }).click()
  await expect(tab('Worktrees')).toContainText('Worktrees')
  await expect(tab('Terminal')).toContainText('Terminal')
  await page.getByRole('button', { name: 'Hide tab names' }).click()
  await expect(tab('Terminal')).not.toContainText('Terminal')
})

test('a workspace takes any hex colour or shade and its own avatar text', async () => {
  const { page } = launched
  await page.locator('[data-workspace-switcher]').click()
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
  await expect(page.locator('[data-workspace-switcher]')).toContainText('B!')
})

test('the AI Hub fills the window without the workspace bar, and the workspace chip goes back', async () => {
  const { page } = launched
  const hub = page.locator('[data-overlay-button]')
  const chip = page.locator('[data-workspace-switcher]')
  const back = page.getByRole('button', { name: /^Back/ })
  await hub.click()
  await expect(page.locator('[data-overlay]')).toBeVisible()
  await expect(back).toBeHidden()
  await expect(page.getByRole('button', { name: /^Settings/ })).toBeVisible()
  await chip.click()
  await expect(page.locator('[data-overlay]')).toBeHidden()
  await expect(back).toBeVisible()
  await expect(chip).toHaveAttribute('aria-expanded', 'false')
})

test('settings open as a title bar tab its × closes', async () => {
  const { page } = launched
  await page.getByRole('button', { name: /^Settings/ }).click()
  const tab = page.locator('[data-page-tab="settings"]')
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await tab.getByRole('button', { name: 'Close settings' }).click()
  await expect(tab).toHaveCount(0)
})
