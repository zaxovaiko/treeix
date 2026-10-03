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

test('asking an agent from the palette records a run with its thinking and answer', async () => {
  const { page } = launched
  await page.locator('[data-page-tab="hub"]').click()
  await page.getByRole('button', { name: 'New agent' }).click()
  await page.getByPlaceholder('Reviewer').fill('Courier')
  await page.getByRole('combobox', { name: /^Runtime/ }).selectOption('agent:fake')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('Ask Courier')
  await page.keyboard.press('Enter')
  await page.getByPlaceholder(/^A one-off question/).fill('Where to?')
  await page.keyboard.press('Enter')

  await expect(page.getByText('Here is a picture')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/^Thought for \d+s$/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Where to\?/ })).toBeVisible()
  await expect(page.locator('header').getByTitle('Done')).toBeVisible()
})

test('a workflow built on the canvas runs its agent, shows each step done and undoes edits', async () => {
  const { page } = launched
  const steps = page.locator('.react-flow__node')
  await page.locator('[data-page-tab="hub"]').click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByRole('textbox', { name: 'Workflow name' }).fill('Relay')

  // A step added with the input selected goes between it and the output
  await steps.filter({ hasText: 'Input' }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption({ label: 'Courier' })
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Relay' })).toBeVisible()

  // Nothing goes after an output, so this one starts unconnected
  await steps.filter({ hasText: 'Output' }).click()
  await page.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(steps).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(steps).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(steps).toHaveCount(4)
  await expect(page.getByText('Connect a step to it')).toBeVisible()
  await steps.filter({ hasText: 'Merge' }).click()
  await page.keyboard.press('Backspace')
  await expect(steps).toHaveCount(3)
  // The deleted card had focus, and undo still hears the keys
  await page.keyboard.press('ControlOrMeta+z')
  await expect(steps).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(steps).toHaveCount(3)

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByPlaceholder(/^The input/).fill('Go')
  await page.keyboard.press('Enter')
  await expect(steps.filter({ hasText: 'Courier' }).getByTitle('Done')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Last run/ }).click()
  await expect(page.getByText('Here is a picture')).toBeVisible()

  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('Run Relay')
  await expect(page.getByText('Run Relay…')).toBeVisible()
})
