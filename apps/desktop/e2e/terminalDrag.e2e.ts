import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

test('a file dropped from Finder on a terminal is typed as its escaped path', async () => {
  const { page, repo } = launched
  const dropped = join(repo, "Screen Shot (1) it's.png")
  const copy = join(repo, 'copied.png')
  writeFileSync(dropped, 'png')
  // A real file on disk, as Finder hands over, carried in a drop's DataTransfer
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(dropped)
  const shell = page.locator('[data-session-id]', { hasText: 'Shell' }).locator('.xterm')
  await shell.click()
  await page.keyboard.type('cp ')
  await shell.evaluate((target) => {
    const input = document.querySelector<HTMLInputElement>('#drop-source')
    if (!input?.files || !target) throw new Error('nothing to drop')
    const data = new DataTransfer()
    for (const file of input.files) data.items.add(file)
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    input.remove()
  })
  await page.keyboard.type(`${copy}\n`)
  await expect.poll(() => existsSync(copy)).toBe(true)
})
