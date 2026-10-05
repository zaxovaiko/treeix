import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('page tabs drag anywhere in the title bar, Safari style, around Run command and the AI Hub held at the centre', async () => {
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
  expect(await x(`[data-page-tab="${first}"]`)).toBeGreaterThan(await x('button:has-text("Run command")'))

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
