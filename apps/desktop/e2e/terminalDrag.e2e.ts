import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

const dropNear = async (target: ReturnType<Launched['page']['locator']>, edge: 'right' | 'bottom'): Promise<{ x: number; y: number }> => {
  const box = await target.boundingBox()
  if (!box) throw new Error('no pane')
  return edge === 'right' ? { x: box.width - 20, y: box.height / 2 } : { x: box.width / 2, y: box.height - 20 }
}

test('tabs and pane headers dropped on a pane split it', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.getByRole('button', { name: 'New tab', exact: true }).click()
  const tabs = page.locator('div[draggable="true"]:has(button[aria-label="Close tab"])')
  await expect(tabs).toHaveCount(2)
  const panes = page.locator('[data-session-id]')

  await tabs.nth(0).dragTo(panes.first(), { targetPosition: await dropNear(panes.first(), 'right') })
  await expect(tabs).toHaveCount(1)
  await expect(panes).toHaveCount(2)

  // Side by side, then the second pane's header drops below the first
  const second = await panes.nth(1).getAttribute('data-session-id')
  await panes.nth(1).locator('div[draggable="true"]').first().dragTo(panes.first(), { targetPosition: await dropNear(panes.first(), 'bottom') })
  const firstBox = await panes.first().boundingBox()
  const movedBox = await page.locator(`[data-session-id="${second}"]`).boundingBox()
  expect(movedBox?.x).toBe(firstBox?.x)
  expect(movedBox?.y).toBeGreaterThan(firstBox?.y ?? 0)
})
