import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

const primary = (launched: Launched): Promise<string> => launched.page.evaluate(() => document.documentElement.style.getPropertyValue('--color-primary'))

test('a plugin light theme is picked for light mode and kept across reloads', async () => {
  const { page } = launched
  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  // Picking a light theme while the mode is fixed to dark switches to light, so the pick shows
  await page.getByRole('group', { name: 'Light themes' }).getByRole('button', { name: 'GitHub' }).click()
  await expect.poll(() => primary(launched)).toBe('#0969da')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}'))).toMatchObject({ themeMode: 'light', lightTheme: 'github-light' })

  await page.getByRole('group', { name: 'Dark themes' }).getByRole('button', { name: 'Dracula' }).click()
  await expect.poll(() => primary(launched)).toBe('#9d6ff0')

  await page.reload()
  await expect.poll(() => primary(launched)).toBe('#9d6ff0')
})
