import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Visual regression for the basic controls in both themes; refresh the baselines with `bun run e2e --update-snapshots`

const fake = {
  id: 'fake',
  label: 'Fake',
  mark: 'F',
  color: '#888888',
  command: null,
  agent: true,
  chat: { adapter: 'acp', command: `"${process.execPath}" "${join(__dirname, 'fakeAcpAgent.mjs')}"` }
}

const looksSame = (locator: Locator, name: string, mask: Locator[] = []): Promise<void> =>
  expect(locator).toHaveScreenshot(name, { animations: 'disabled', maxDiffPixelRatio: 0.01, mask })

for (const themeMode of ['dark', 'light'] as const) {
  test.describe(themeMode, () => {
    let home: string
    let app: ElectronApplication
    let page: Page

    test.beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-e2e-')))
      app = await electron.launch({
        args: [resolve(__dirname, '..'), '-ApplePersistenceIgnoreState', 'YES'],
        env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data'), TREEIX_HEADLESS: '1' }
      })
      page = await app.firstWindow()
      await page.evaluate((settings) => localStorage.setItem('settings', settings), JSON.stringify({ themeMode, customAgents: [fake], chatAgent: 'fake' }))
      await page.reload()
      await expect(page.getByPlaceholder('Message Fake')).toBeVisible({ timeout: 20_000 })
    })
    test.afterAll(async () => {
      await app.close()
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
    })

    test('sidebar', async () => {
      await looksSame(page.locator('aside').first(), `${themeMode}-sidebar.png`)
    })

    test('composer', async () => {
      await looksSame(page.getByPlaceholder('Message Fake').locator('xpath=ancestor::div[contains(@class, "pb-3")][1]'), `${themeMode}-composer.png`)
    })

    test('folder picker', async () => {
      await page.getByTitle('Where the chat runs').click()
      const search = page.getByPlaceholder('Search folders or type a path')
      // The fake home's path changes every run
      await looksSame(search.locator('xpath=..'), `${themeMode}-folder-picker.png`, [page.locator('[dir=rtl]')])
      await page.keyboard.press('Escape')
    })
  })
}
