import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'notes.md': Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') }, 'notes.md')
})
test.afterAll(() => launched.close())

test('the minimap hides from the palette and shows again from the Editor settings page', async () => {
  const { page } = launched
  const minimap = page.locator('.monaco-editor .minimap')
  await expect(minimap).toBeVisible()

  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('minimap')
  await page.getByRole('button', { name: 'Hide editor minimap' }).click()
  await expect(minimap).toBeHidden()

  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByRole('switch', { name: 'Minimap' }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}'))).toMatchObject({ editorMinimap: true })
})
