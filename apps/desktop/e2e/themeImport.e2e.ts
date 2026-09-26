import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'a.ts': 'const answer = 42\n' }, 'a.ts')
})
test.afterAll(() => launched.close())

// VS Code theme files are JSONC; the keyword color shows the token colors reach the editor
const THEME = `{
  // exported from VS Code
  "name": "Pink", "type": "dark",
  "colors": { "editor.background": "#101010", "editor.foreground": "#eeeeee", "button.background": "#ff00aa", },
  "tokenColors": [{ "scope": ["keyword", "storage", "storage.type"], "settings": { "foreground": "#ff00aa" } }],
}`

test('an imported VS Code theme colors the app and the code, and can be removed', async () => {
  const { page } = launched
  const keyword = page.locator('.monaco-editor .view-line span span', { hasText: /^const$/ })
  await expect(keyword).toBeVisible()

  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles({ name: 'pink.json', mimeType: 'application/json', buffer: Buffer.from(THEME) })
  const darkThemes = page.getByRole('group', { name: 'Dark themes' })
  await expect(darkThemes.getByRole('button', { name: 'Pink', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-background'))).toBe('#101010')

  await page.keyboard.press('Escape')
  await expect(keyword).toHaveCSS('color', 'rgb(255, 0, 170)')

  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await darkThemes.getByRole('button', { name: 'Remove Pink' }).click()
  await expect(darkThemes.getByRole('button', { name: 'Pink', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-background'))).toBe('#000000')
})
