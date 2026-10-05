import { expect, test } from '@playwright/test'
import { launch } from './app'

test('a page opened beside another in a narrow pane keeps its main zone and its toolbar in view', async () => {
  const { app, page, close } = await launch({ 'README.md': '# alpha\n' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 520))
  await page.evaluate(() => localStorage.setItem('app.splitWidth', '400'))
  await page.reload()
  await page.locator('[data-page-tab="worktrees"]').click()
  await page.locator('[data-page-tab="terminal"]').click({ modifiers: ['Shift'] })
  const pane = page.locator('[data-split-pane="terminal"]')
  await pane.getByRole('button', { name: /Shell/ }).first().click()
  await pane.getByRole('button', { name: /Show list/ }).click()
  await expect(pane.locator('[data-zone="list"]')).toBeVisible()

  const box = async (selector: string): Promise<{ x: number; width: number }> => (await pane.locator(selector).boundingBox()) ?? { x: 0, width: 0 }
  const paneBox = (await pane.boundingBox()) ?? { x: 0, width: 0 }
  expect((await box('[data-zone="main"]')).width).toBeGreaterThanOrEqual(240)
  // The inspector does not fit beside the list, so it waits for a wider pane instead of crushing the terminal
  await expect(pane.locator('[data-zone="inspector"]')).toHaveCount(0)
  const toggle = await box('[aria-label="Toggle inspector"]')
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(paneBox.x + paneBox.width)
  await close()
})
