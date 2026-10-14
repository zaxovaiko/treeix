import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, type Launched } from './app'

const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'notes.md': lines.join('\n') })
  // Changes at both ends leave the middle hidden between two hunks
  writeFileSync(join(launched.repo, 'notes.md'), ['first', ...lines.slice(1, -1), 'last'].join('\n'))
  await launched.page.evaluate((selected) => localStorage.setItem('app.place@all', JSON.stringify({ appTab: 'worktrees', selected })), launched.repo)
  await launched.page.reload()
})
test.afterAll(() => launched.close())

test('the unchanged lines between hunks of a diff can be expanded', async () => {
  const { page } = launched
  await expect(page.getByText('line 20', { exact: true })).toHaveCount(0)
  await page.locator('[data-expand-button]').first().click()
  await expect(page.getByText('line 20', { exact: true }).first()).toBeVisible()
})
