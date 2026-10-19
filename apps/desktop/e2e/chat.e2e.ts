import { expect, test } from '@playwright/test'
import { FAKE_CHAT, launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, FAKE_CHAT)
})
test.afterAll(() => launched.close())

test('one chat opens with the last picked agent, shows what it is doing and zooms its images', async () => {
  const { page } = launched
  await expect(page.getByPlaceholder('Message Fake')).toBeVisible({ timeout: 20_000 })

  // Before the first message the agent can still change
  await page.getByTitle('Agent', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByPlaceholder('Message Fake').fill('Show me')
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 20_000 })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Thinking' })).toBeVisible()
  await expect(page.getByText('Here is a picture')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden()
  await expect(page.getByText(/^Thought for \d+s$/)).toBeVisible()
  // The conversation belongs to the agent now
  await expect(page.getByTitle('Agent', { exact: true })).toBeHidden()

  await page.getByTitle('Click to open full screen').click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.locator('[style*="scale("]').last()).toHaveAttribute('style', /scale\((?!1\))/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden()
})
