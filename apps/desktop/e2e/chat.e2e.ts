import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched

const fake = {
  id: 'fake',
  label: 'Fake',
  mark: 'F',
  color: '#888888',
  command: null,
  agent: true,
  chat: { adapter: 'acp', command: `"${process.execPath}" "${join(__dirname, 'fakeAcpAgent.mjs')}"` }
}

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, 'README.md')
  const { page } = launched
  await page.evaluate((agent) => localStorage.setItem('settings', JSON.stringify({ customAgents: [agent], chatAgent: 'fake' })), fake)
  await page.reload()
})
test.afterAll(() => launched.close())

test('one chat opens with the last picked agent, shows what it is doing, widens, and zooms its images', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('New chat')
  await page.keyboard.press('Enter')

  await expect(page.getByText('Chat with Fake')).toBeVisible({ timeout: 20_000 })

  // Before the first message the agent can still change
  await page.getByTitle('Agent', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Full width' }).click()
  await expect(page.getByRole('button', { name: 'Fixed width' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}').chatFullWidth)).toBe(true)

  await page.getByPlaceholder('Message Fake').fill('Show me')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Esc to stop' })).toContainText('Thinking')
  await expect(page.getByText('Here is a picture')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Esc to stop' })).toBeHidden()
  await expect(page.getByText(/^Thought for \d+s$/)).toBeVisible()
  // The conversation belongs to the agent now
  await expect(page.getByTitle('Agent', { exact: true })).toBeHidden()

  await page.getByTitle('Click to open full screen').click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.locator('[style*="scale("]').last()).toHaveAttribute('style', /scale\((?!1\))/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden()
})
