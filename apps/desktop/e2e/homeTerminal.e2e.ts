import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' }, 'README.md')
})
test.afterAll(() => launched.close())

test('⌘⇧H opens a shell in ~ in zen, outside the workspace, and takes you back', async () => {
  const { page, repo } = launched
  const terminalTab = page.locator('[data-page-tab="terminal"]')
  const rail = page.locator('[data-zone="rail"]')
  await expect(rail).toBeVisible()

  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Meta+Shift+H')
  // Zen hides the rail and the page tabs, leaving the terminal alone
  await expect(rail).toHaveCount(0)
  await expect(terminalTab).toHaveCount(0)
  const terminal = page.locator('.xterm').first()
  await expect(terminal).toBeVisible({ timeout: 15_000 })
  await terminal.click()
  await page.keyboard.type('pwd > here.txt\n')
  // The fake home holds the repository at code/alpha
  const home = dirname(dirname(repo))
  await expect.poll(() => readFile(join(home, 'here.txt'), 'utf8').catch(() => ''), { timeout: 15_000 }).toBe(`${home}\n`)

  await page.keyboard.press('Meta+Shift+H')
  await expect(rail).toBeVisible()
  await expect(terminalTab).not.toHaveAttribute('aria-current', 'page')
})
