import { expect, test } from '@playwright/test'
import { confluenceState } from '../scripts/shot-fixtures'
import { launch, type Launched } from './app'

let launched: Launched

// The page comes from the cache the screenshots use, so nothing asks a real Confluence
test.beforeAll(async () => {
  launched = await launch({ 'README.md': 'alpha' })
  const { page, repo } = launched
  await page.evaluate(
    (state) => {
      for (const [key, value] of Object.entries(state)) localStorage.setItem(key, JSON.stringify(value))
    },
    { ...confluenceState(), settings: { plugins: { jira: true, confluence: true } }, 'app.place@all': { appTab: 'confluence', selected: repo, viewer: null } }
  )
  await page.reload()
})
test.afterAll(() => launched.close())

test('a double-clicked page body edits in place, and leaving it with changes asks to save or cancel', async () => {
  const { page } = launched
  const body = page.locator('#confluence-body')
  await body.getByText('Paying customers should never').dblclick()

  const box = body.getByRole('textbox')
  await expect(box).toBeFocused()
  await expect(body.getByRole('button', { name: 'Save' })).toBeVisible()
  await page.keyboard.type(' Edited.')

  await page.getByRole('heading', { name: 'Billing self-service' }).click()
  const dialog = page.getByRole('heading', { name: 'Save the page?' })
  await expect(dialog).toBeVisible()

  // Clicking outside the question goes back to editing
  await page.mouse.click(5, 5)
  await expect(dialog).toBeHidden()
  await expect(box).toHaveValue(/Edited\./)

  await box.press('Escape')
  await page.getByRole('button', { name: 'Cancel' }).last().click()
  await expect(box).toBeHidden()
  await expect(body).not.toContainText('Edited.')
})

test('a save that fails keeps the edit open with the reason', async () => {
  const { page } = launched
  const body = page.locator('#confluence-body')
  await body.getByText('Paying customers should never').dblclick()
  await page.keyboard.type('x')
  await body.getByRole('button', { name: 'Save' }).click()
  // The fake home has no API token
  await expect(body).toContainText('API token')
  await expect(body.getByRole('textbox')).toBeVisible()
})
