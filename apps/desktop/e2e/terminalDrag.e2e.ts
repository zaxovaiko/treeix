import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched
test.beforeAll(async () => {
  launched = await launch({ 'README.md': '# alpha\n' })
})
test.afterAll(() => launched.close())

test('a file dropped from Finder on a terminal is typed as its escaped path', async () => {
  const { page, repo } = launched
  await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Shell' }).click()
  const dropped = join(repo, "Screen Shot (1) it's.png")
  const copy = join(repo, 'copied.png')
  writeFileSync(dropped, 'png')
  // A real file on disk, as Finder hands over, carried in a drop's DataTransfer
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(dropped)
  const shell = page.locator('[data-session-id]').locator('.xterm')
  await shell.click()
  await page.keyboard.type('cp ')
  await shell.evaluate((target) => {
    const input = document.querySelector<HTMLInputElement>('#drop-source')
    if (!input?.files || !target) throw new Error('nothing to drop')
    const data = new DataTransfer()
    for (const file of input.files) data.items.add(file)
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    input.remove()
  })
  await page.keyboard.type(`${copy}\n`)
  await expect.poll(() => existsSync(copy)).toBe(true)
})
