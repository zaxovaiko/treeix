import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'needle in main\n' }, 'README.md')
  const worktree = `${launched.repo}-feat`
  spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat', worktree], { cwd: launched.repo })
  writeFileSync(`${worktree}/notes.md`, 'needle in feat\n')
  await launched.page.reload()
})
test.afterAll(() => launched.close())

test('search covers the selected worktree, and every worktree with the toggle on, the selected one highlighted', async () => {
  const { page } = launched
  await page.keyboard.press('Meta+Shift+F')
  await page.getByPlaceholder(/^Search in/).fill('needle')
  await expect(page.getByText('1 result in 1 file')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Search every worktree' }).click()
  await expect(page.getByText('3 results in 3 files')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: /^alpha 1$/ })).toHaveClass(/font-medium/)
  await expect(page.getByRole('button', { name: /^alpha-feat 2$/ })).not.toHaveClass(/font-medium/)
})
