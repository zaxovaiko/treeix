import { expect, test } from '@playwright/test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched
// A stand-in acli that knows one project, so no real Jira is asked
const stubs = mkdtempSync(join(tmpdir(), 'treeix-acli-'))
const originalPath = process.env.PATH
test.beforeAll(async () => {
  writeFileSync(
    join(stubs, 'acli'),
    `#!/bin/sh\ncase "$*" in *'project list'*) echo '[{"key":"ABC"}]' ;; *'workitem view ABC-12'*) echo '{"key":"ABC-12","fields":{"summary":"Stub ticket","status":{"name":"To Do"}}}' ;; *) echo '[]' ;; esac\n`
  )
  chmodSync(join(stubs, 'acli'), 0o755)
  process.env.PATH = `${stubs}:${originalPath}`
  launched = await launch({ 'README.md': '# alpha\n' })
  // Jira is off by default, and so are its key links
  await launched.page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('settings') ?? '{}'), plugins: { jira: true } })))
  await launched.page.reload()
})
test.afterAll(async () => {
  await launched.close()
  process.env.PATH = originalPath
  rmSync(stubs, { recursive: true, force: true })
})

/** ⌘-clicks the first cell of the terminal's first row */
async function metaClickFirstRow(): Promise<void> {
  const { page } = launched
  const screen = await page.locator('.xterm-screen').first().boundingBox()
  const rows = await page.evaluate(() => document.querySelector('.xterm-rows')?.childElementCount ?? 0)
  if (!screen) throw new Error('No terminal screen')
  const cell = { x: screen.x + 20, y: screen.y + (rows ? screen.height / rows / 2 : 8) }
  // xterm looks for links when the pointer enters a cell, so it comes from elsewhere as a hand would
  await page.mouse.move(cell.x, cell.y + 200)
  await page.mouse.move(cell.x, cell.y)
  await page.waitForTimeout(300)
  await page.keyboard.down('Meta')
  await page.mouse.click(cell.x, cell.y)
  await page.keyboard.up('Meta')
}

test('⌘-click on a path cut short opens the worktree file it ends', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()
  // Printed from the repo root's view, but the file sits deeper
  await page.keyboard.type(`cd ${launched.repo} && mkdir -p src/deep && echo 'export const deepValue = 1' > src/deep/widget.ts && clear && printf 'deep/widget.ts:1\\n'\n`)
  await page.waitForTimeout(1000)
  await metaClickFirstRow()
  await expect(page.getByText('deepValue').first()).toBeVisible({ timeout: 10_000 })
})

test('⌘-click on a Jira key of a known project opens it in Tasks, other KEY-1 words stay text', async () => {
  const { page } = launched
  await page
    .getByRole('button', { name: /^Terminal/ })
    .first()
    .click()
  await page.locator('.xterm').first().click()
  await page.keyboard.type("clear && printf 'UTF-8\\n'\n")
  await page.waitForTimeout(1000)
  // UTF-8 on the first row is no project's key
  await metaClickFirstRow()
  await page.waitForTimeout(500)
  await expect(page.locator('.xterm').first()).toBeVisible()
  await page.keyboard.type("clear && printf 'ABC-12 fix\\n'\n")
  await page.waitForTimeout(1000)
  await metaClickFirstRow()
  await expect(page.getByText('Stub ticket').first()).toBeVisible({ timeout: 10_000 })
})
