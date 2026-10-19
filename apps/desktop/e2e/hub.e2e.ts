import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FAKE_CHAT, launch, type Launched } from './app'

let launched: Launched
let api: Server

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

/** A titled control; once hovered, its title lives on as the tooltip's data-tip */
const titled = (page: Launched['page'], title: string): ReturnType<Launched['page']['locator']> => page.locator(`[title="${title}"], [data-tip="${title}"]`)

/** Opens a field's dropdown, searches it and picks the first match */
async function choose(page: Launched['page'], field: string, search: string): Promise<void> {
  await titled(page, field).click()
  await page.keyboard.type(search)
  await page.keyboard.press('Enter')
}

const newBot = async (page: Launched['page'], name: string): Promise<void> => {
  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'New bot' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(name)
}

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, { settings: JSON.stringify({ ...JSON.parse(FAKE_CHAT.settings), plugins: { hub: true } }) })
})
test.afterAll(async () => {
  api?.close()
  await launched.close()
})

test('a bot made in Settings chats as itself from the sidebar and can be deleted', async () => {
  const { page } = launched
  await newBot(page, 'Scout')
  // Esc closes an open dropdown, not the editor around it
  await titled(page, 'Runtime').click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Scout')
  await choose(page, 'Runtime', 'Fake')
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByText('The runtime lists no models; type one in')).toBeVisible()
  await page.getByPlaceholder(/^What it does and how/).fill('You scout ahead.')
  await page.getByRole('button', { name: 'Create bot' }).click()

  const row = page.getByRole('button', { name: /^Scout / })
  await expect(row).toBeVisible()
  await row.click()
  await page.getByPlaceholder('Message Scout').fill('Show me')
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 20_000 })
  await page.keyboard.press('Enter')
  await expect(page.getByText('Here is a picture')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Edit agent' }).click()
  await expect(page.getByPlaceholder(/^What it does and how/)).toHaveValue('You scout ahead.')
  await page.keyboard.press('Escape')

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete agent' }).click()
  await expect(row).toBeHidden()
})

test('a bot on an OpenAI-compatible API lists its models and chats with its instructions', async () => {
  const { page } = launched
  const baseUrl = await startApi()
  await newBot(page, 'Local')
  await choose(page, 'Runtime', 'Other OpenAI')
  await page.getByPlaceholder('http://localhost:1234/v1').fill(baseUrl)
  await expect(page.getByRole('button', { name: 'Create bot' })).toBeDisabled()
  // The models load once the URL is in, without asking
  await page.getByTitle('Model', { exact: true }).click()
  await page.getByRole('button', { name: 'Tiny tiny' }).click()
  await page.getByPlaceholder(/^What it does and how/).fill('You run locally.')
  await page.getByRole('button', { name: 'Create bot' }).click()

  await page.getByRole('button', { name: /^Local / }).click()
  await page.getByPlaceholder('Message Local').fill('Hi')
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 20_000 })
  await page.keyboard.press('Enter')
  await expect(page.getByText('tiny heard 2 messages, first system')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/^Thought for \d+s$/)).toBeVisible()
})

test('a workflow made in Settings is renamed, saved and deleted', async () => {
  const { page } = launched
  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  const name = page.getByRole('textbox', { name: 'Workflow name' })
  await name.fill('Relay')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('nav').getByRole('button', { name: 'Relay', exact: true })).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('nav').getByRole('button', { name: 'Relay', exact: true })).toBeHidden()
})
