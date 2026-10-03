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

/** A titled control; once hovered, its title lives on as the tooltip's data-tip */
const titled = (page: Launched['page'], title: string): ReturnType<Launched['page']['locator']> => page.locator(`[title="${title}"], [data-tip="${title}"]`)

/** Opens a field's dropdown, searches it and picks the first match */
async function choose(page: Launched['page'], field: string, search: string): Promise<void> {
  await titled(page, field).click()
  await page.keyboard.type(search)
  await page.keyboard.press('Enter')
}

test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' }, 'README.md')
  const { page } = launched
  await page.evaluate((agent) => localStorage.setItem('settings', JSON.stringify({ customAgents: [agent], plugins: { hub: true } })), fake)
  await page.reload()
  // CI's screen is small; the canvas has to fit there
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 740))
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
  // Esc closes an open dropdown, not the editor around it
  await titled(page, 'Runtime').click()
  await page.keyboard.press('Escape')
  await expect(page.getByPlaceholder('Reviewer')).toHaveValue('Scout')
  await choose(page, 'Runtime', 'Fake')
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 20_000 })
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
  await choose(page, 'Runtime', 'Other OpenAI')
  await page.getByPlaceholder('http://localhost:1234/v1').fill(baseUrl)
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  // The models load once the URL is in, without asking
  await page.getByTitle('Model', { exact: true }).click()
  await page.getByRole('button', { name: 'Tiny tiny' }).click()
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
  await choose(page, 'Runtime', 'Fake')
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
  await choose(page, 'The agent this step asks', 'Courier')
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

test('an approval step holds the run, counted on the tab, until approved', async () => {
  const { page } = launched
  const steps = page.locator('.react-flow__node')
  const hubTab = page.locator('[data-page-tab="hub"]')
  // The first Esc clears the last test's query, the next closes the palette
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await hubTab.click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByRole('textbox', { name: 'Workflow name' }).fill('Gate')
  await steps.filter({ hasText: 'Input' }).click()
  await page.getByRole('button', { name: 'Approval', exact: true }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByPlaceholder(/^The input/).fill('v1')
  await page.keyboard.press('Enter')
  await expect(steps.filter({ hasText: 'Approval' }).getByTitle('Needs you')).toBeVisible({ timeout: 20_000 })
  await expect(hubTab.getByTitle('1 run waiting for you')).toBeVisible()

  await page.getByRole('button', { name: /^Last run/ }).click()
  await expect(page.getByText('Go on with v1?')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(/^Done · /)).toBeVisible()
  await expect(hubTab.getByTitle('1 run waiting for you')).toBeHidden()
})

test('a first launch opens the AI Hub', async () => {
  const fresh = await launch({ 'README.md': 'alpha' })
  try {
    await expect(fresh.page.getByRole('button', { name: 'Create an agent' })).toBeVisible()
  } finally {
    await fresh.close()
  }
})
