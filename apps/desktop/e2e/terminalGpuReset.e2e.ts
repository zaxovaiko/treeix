import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

const PRINT = `clear; for i in $(seq 1 20); do printf '\\033[3%dmline %02d ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\\033[0m\\n' $((i%7+1)) $i; done\n`

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('terminals sharing a glyph atlas still draw text after the GPU process resets', async () => {
  const { page, app } = launched
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.locator('button[title^="Split right"]').first().click()
  const panes = page.locator('.xterm')
  await expect(panes).toHaveCount(2)
  // The shells start their prompts
  await page.waitForTimeout(2000)
  for (const i of [0, 1]) {
    await panes.nth(i).click()
    await page.keyboard.type(PRINT)
  }
  // Only the text half: the cursor sits below it and blinks
  const text = async (i: number): Promise<string> => {
    const box = await panes.nth(i).evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height / 3) }
    })
    return app.evaluate(async ({ BrowserWindow }, box) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(box)).toBitmap().toString('base64'), box)
  }
  // The GPU renderer keeps its text out of the DOM, so the print is given time instead
  await page.waitForTimeout(1500)
  const before = [await text(0), await text(1)]

  const restored = page.waitForEvent('console', (message) => message.text().includes('webglcontextrestored'))
  await app.evaluate(({ app }) => {
    const gpu = app.getAppMetrics().find((metric) => metric.type === 'GPU')
    if (gpu) process.kill(gpu.pid, 'SIGKILL')
  })
  await restored
  await expect.poll(async () => [await text(0), await text(1)], { timeout: 10_000 }).toEqual(before)
})
