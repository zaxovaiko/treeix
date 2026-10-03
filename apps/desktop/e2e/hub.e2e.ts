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
  await page.evaluate((agent) => localStorage.setItem('settings', JSON.stringify({ customAgents: [agent], plugins: { hub: true } })), fake)
  await page.reload()
})
test.afterAll(() => launched.close())

test('an agent made in the AI Hub chats as itself and joins the new-tab menu', async () => {
  const { page } = launched
  await page.locator('[data-page-tab="hub"]').click()
  await page.getByRole('button', { name: 'Create an agent' }).click()

  await page.getByPlaceholder('Reviewer').fill('Scout')
  await page.getByRole('combobox', { name: /^Runtime/ }).selectOption('fake')
  await page.getByRole('button', { name: 'Detect models' }).click()
  await expect(page.getByRole('button', { name: 'Detect models' })).toBeEnabled({ timeout: 20_000 })
  await expect(page.locator('.text-destructive')).toHaveCount(0)
  await page.getByPlaceholder(/^Who the agent is/).fill('You scout ahead.')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByText('Chat with Scout')).toBeVisible({ timeout: 20_000 })
  // The persona is the point of the chat, so it can't be swapped for another agent
  await expect(page.getByTitle('Agent', { exact: true })).toBeHidden()
  await page.getByPlaceholder('Message Scout').fill('Show me')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Here is a picture')).toBeVisible()

  await page.getByRole('button', { name: 'Edit agent' }).click()
  await expect(page.getByPlaceholder(/^Who the agent is/)).toHaveValue('You scout ahead.')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('New Scout tab')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Chat with Scout')).toBeVisible({ timeout: 20_000 })

  await page.locator('[data-page-tab="hub"]').click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete agent' }).click()
  await expect(page.getByRole('button', { name: 'Create an agent' })).toBeVisible()
})
