import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n', 'dropped.ts': 'export const dropped = 1\n' })
})
test.afterAll(() => launched.close())

test('a file opened with Treeix from Finder shows beside the terminals, even outside any repository', async () => {
  const { app, page, repo } = launched
  const outside = join(dirname(dirname(repo)), 'notes.txt')
  writeFileSync(outside, 'written outside the repo\n')
  await page.locator('[data-page-tab="worktrees"]').click({ modifiers: ['Shift'] })
  await app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault: () => undefined }, path), outside)
  await expect(page.locator('[data-page-tab="terminal"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Close notes.txt' })).toBeVisible()
  await expect(page.getByText('written outside the repo')).toBeVisible()
})

test('a file dropped from Finder on the window opens like one opened with Treeix', async () => {
  const { page, repo } = launched
  await page.locator('[data-page-tab="worktrees"]').click({ modifiers: ['Shift'] })
  // A real file on disk, as Finder hands over, carried in a drop's DataTransfer
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(join(repo, 'dropped.ts'))
  await page
    .locator('[data-zone="main"]')
    .first()
    .evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#drop-source')
      if (!input?.files) throw new Error('nothing to drop')
      const data = new DataTransfer()
      for (const file of input.files) data.items.add(file)
      for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
      input.remove()
    })
  await expect(page.locator('[data-page-tab="terminal"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Close dropped.ts' })).toBeVisible()
  await expect(page.getByText('export const dropped')).toBeVisible()
})
