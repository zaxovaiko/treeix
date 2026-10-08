import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('page tabs drag anywhere in the title bar, Safari style, around the workspace and the AI Hub held at the centre', async () => {
  const { page } = launched
  const order = (): Promise<string[]> => page.locator('[data-page-tab]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-page-tab') ?? ''))
  const x = async (selector: string): Promise<number> => (await page.locator(selector).first().boundingBox())?.x ?? 0
  const before = await order()
  expect(before.length).toBeGreaterThan(2)
  const [first, second] = before

  // Onto the empty space on the right, past the centre segment
  const center = page.locator('[data-bar-item="bar:search"]')
  const box = await center.boundingBox()
  if (!box) throw new Error('no centre segment')
  await page.locator(`[data-page-tab="${first}"]`).dragTo(center, { targetPosition: { x: box.width + 30, y: box.height / 2 }, force: true })
  await expect.poll(order).toEqual([...before.slice(1), first])
  expect(await x(`[data-page-tab="${first}"]`)).toBeGreaterThan(await x('[data-bar-item="bar:search"]'))

  // Back to the left, before the tab that was second
  await page.locator(`[data-page-tab="${first}"]`).dragTo(page.locator(`[data-page-tab="${second}"]`), { targetPosition: { x: 2, y: 5 } })
  await expect.poll(order).toEqual(before)

  // Kept across a reload
  await page.locator(`[data-page-tab="${second}"]`).dragTo(page.locator(`[data-page-tab="${first}"]`), { targetPosition: { x: 2, y: 5 } })
  await page.reload()
  await expect.poll(order).toEqual([second, first, ...before.slice(2)])

  // The segment stays at the centre of the window whatever sits on either side
  const width = await page.evaluate(() => window.innerWidth)
  const held = await center.boundingBox()
  expect(Math.abs((held?.x ?? 0) + (held?.width ?? 0) / 2 - width / 2)).toBeLessThan(2)
})

test('settings and the other title bar buttons drag around the row like the tabs', async () => {
  const { page } = launched
  const settings = page.locator('[data-bar-item="bar:settings"]')
  const firstTab = page.locator('[data-page-tab]').first()
  await settings.dragTo(firstTab, { targetPosition: { x: 2, y: 5 } })
  const x = async (locator: typeof settings): Promise<number> => (await locator.boundingBox())?.x ?? 0
  await expect.poll(() => x(settings)).toBeLessThan(await x(page.locator('[data-bar-item="bar:search"]')))
  await page.reload()
  expect(await x(settings)).toBeLessThan(await x(firstTab))
  await expect(settings.getByRole('button', { name: /^Settings/ })).toBeVisible()
})
