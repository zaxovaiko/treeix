import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { launch, type Launched } from './app'

let launched: Launched
let api: Server

const fake = {
  id: 'fake',
  label: 'Fake',
  mark: 'F',
  color: '#888888',
  command: null,
  agent: true,
  chat: { adapter: 'acp', command: `"${process.execPath}" "${join(__dirname, 'fakeAcpAgent.mjs')}"` }
}

/** An OpenAI-compatible API that thinks, then answers with what it was sent */
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
function startApi(): Promise<string> {
  api = createServer((request, response) => {
    if (request.url === '/v1/models') return void response.end(JSON.stringify({ data: [{ id: 'tiny', name: 'Tiny' }] }))
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      const { model, messages } = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse({ choices: [{ delta: { reasoning: 'Pondering' } }] }))
      setTimeout(() => {
        response.write(sse({ choices: [{ delta: { content: `${model} heard ${messages.length} messages, first ${messages[0].role}` } }] }))
        response.end('data: [DONE]\n\n')
      }, 300)
    })
  })
  return new Promise((resolve) => api.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`)))
}

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, 'README.md')
  const { page } = launched
  await page.evaluate((agent) => localStorage.setItem('settings', JSON.stringify({ customAgents: [agent], plugins: { hub: true } })), fake)
  await page.reload()
})
test.afterAll(async () => {
  api?.close()
  await launched.close()
})

test('an agent made in the AI Hub chats as itself and joins the new-tab menu', async () => {
  const { page } = launched
  await page.locator('[data-page-tab="hub"]').click()
  await page.getByRole('button', { name: 'Create an agent' }).click()

  await page.getByPlaceholder('Reviewer').fill('Scout')
  await page.getByRole('combobox', { name: /^Runtime/ }).selectOption('agent:fake')
  await page.getByRole('button', { name: 'Detect models' }).click()
  await expect(page.getByRole('button', { name: 'Detect models' })).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByText('The runtime lists no models; type one in')).toBeVisible()
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

test('an agent on an OpenAI-compatible API lists its models and chats with its instructions', async () => {
  const { page } = launched
  const baseUrl = await startApi()
  await page.locator('[data-page-tab="hub"]').click()
  await page.getByRole('button', { name: 'Create an agent' }).click()

  await page.getByPlaceholder('Reviewer').fill('Local')
  await page.getByRole('combobox', { name: /^Runtime/ }).selectOption('api:')
  await page.getByPlaceholder('http://localhost:1234/v1').fill(baseUrl)
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Detect models' }).click()
  await expect(page.locator('#hub-models option')).toHaveAttribute('value', 'tiny')
  await page.getByRole('combobox', { name: 'Model' }).fill('tiny')
  await page.getByPlaceholder(/^Who the agent is/).fill('You run locally.')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByText('Chat with Local')).toBeVisible()
  await page.getByPlaceholder('Message Local').fill('Hi')
  await page.keyboard.press('Enter')
  await expect(page.getByText('tiny heard 2 messages, first system')).toBeVisible()
  await expect(page.getByText(/^Thought for \d+s$/)).toBeVisible()
})
