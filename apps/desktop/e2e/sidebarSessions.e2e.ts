import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a sidebar session is renamed by double-click or from its context menu', async () => {
  const { app, page } = launched
  const sidebar = page.locator('[data-app-sidebar]')
  // Before the terminal plugin loads, ⌘⇧H opens an empty home with no shell to start
  await expect(page.locator('[data-page-tab="terminal"]')).toBeVisible()
  await page.keyboard.press('Meta+Shift+H')
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  const row = sidebar.locator('button[draggable]:not([data-workspace])').first()
  await expect(row).toBeVisible()

  await row.dblclick()
  const input = sidebar.getByLabel('Session name')
  await expect(input).toBeFocused()
  await input.fill('Deploy notes')
  await input.press('Enter')
  await expect(sidebar.getByText('Deploy notes')).toBeVisible()

  // The native menu cannot be clicked, so its main-process handler picks Rename… instead
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('showContextMenu')
    ipcMain.handle('showContextMenu', (_event, items: { id?: string; label?: string }[]) => items.find((item) => item.label === 'Rename…')?.id ?? null)
  })
  await sidebar.getByText('Deploy notes').click({ button: 'right' })
  await expect(input).toBeFocused()
  await input.fill('Release prep')
  await input.press('Enter')
  await expect(sidebar.getByText('Release prep')).toBeVisible()
})

test("hovering a workspace's plus lists the sessions it can start", async () => {
  const { page, repo } = launched
  await page.evaluate((repoPath) => localStorage.setItem('workspaces', JSON.stringify([{ id: 'alpha', name: 'Alpha', color: '#64748b', repoPaths: [repoPath] }])), repo)
  await page.reload()
  await page.locator('[data-workspace="alpha"]').hover()
  await page.getByRole('button', { name: /^New shell in Alpha/ }).hover()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'New shell here' })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(menu).toBeHidden()

  // The pointer crosses from the plus into the menu without it closing
  await page.locator('[data-workspace="alpha"]').hover()
  await page.getByRole('button', { name: /^New shell in Alpha/ }).hover()
  await menu.getByRole('menuitem', { name: 'New shell here' }).click()
  await expect(menu).toBeHidden()
  await expect(page.locator('[data-workspace="alpha"] + * button[draggable]')).toHaveCount(1, { timeout: 15_000 })
})
