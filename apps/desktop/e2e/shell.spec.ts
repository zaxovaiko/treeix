import { expect, test, type Page } from '@playwright/test'

// The shell on the in-browser mock daemon (src/ipc/mock.ts): 10 seeded sessions, the first tab active

const panes = (page: Page) => page.locator('.stage:not([hidden]) .panes:not([hidden]) .pane')
const tabRows = (page: Page) => page.locator('.side .trow')
const activeRow = (page: Page) => page.locator('.side .trow.on')
const terminal = (page: Page) => page.locator('.stage:not([hidden]) .panes:not([hidden]) .term')

async function open(page: Page, query = '') {
  await page.goto(`/${query}`)
  await expect(terminal(page).first()).toBeVisible()
}

/** The UI blob is saved after a short debounce; the mock keeps it in localStorage */
async function persisted(page: Page, fragment: string) {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('treeix-ui'))).toContain(fragment)
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('Meta+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').fill(query)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
}

test('new shell opens a tab that runs what is typed', async ({ page }) => {
  await open(page)
  const before = await tabRows(page).count()
  await page.getByRole('button', { name: /^New shell/ }).first().click()
  await expect(tabRows(page)).toHaveCount(before + 1)
  await expect(panes(page)).toHaveCount(1)
  await terminal(page).click()
  await page.keyboard.type('echo hi')
  await page.keyboard.press('Enter')
  // The mock titles a session after the command it ran
  await expect(activeRow(page)).toContainText('echo hi')
})

/** Visible panes left to right, then top to bottom */
async function layout(page: Page) {
  const boxes = await Promise.all((await panes(page).all()).map(async (pane) => ({ pane, box: (await pane.boundingBox())! })))
  return boxes.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)
}

test('split right and down, move focus, close panes', async ({ page }) => {
  await open(page)
  await page.locator('.ctop').getByRole('button', { name: /^Split right/ }).click()
  await expect(panes(page)).toHaveCount(2)
  await page.keyboard.press('Meta+Shift+d')
  await expect(panes(page)).toHaveCount(3)

  const [first, right, down] = await layout(page)
  expect(right.box.x).toBeGreaterThanOrEqual(first.box.x + first.box.width - 1)
  expect(down.box.x).toBe(right.box.x)
  expect(down.box.y).toBeGreaterThanOrEqual(right.box.y + right.box.height - 1)
  await expect(down.pane).toHaveClass(/focus/)
  await expect(activeRow(page).locator('.tag:not(.mono)')).toContainText('3')

  await page.keyboard.press('Meta+Alt+ArrowUp')
  await expect(right.pane).toHaveClass(/focus/)
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await expect(first.pane).toHaveClass(/focus/)
  await expect(right.pane).toHaveClass(/dimmed/)
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(right.pane).toHaveClass(/focus/)

  await down.pane.getByRole('button', { name: /^Close pane/ }).click()
  await expect(panes(page)).toHaveCount(2)
  await page.keyboard.press('Meta+w')
  await expect(panes(page)).toHaveCount(1)
  await expect(panes(page)).not.toHaveClass(/focus|dimmed/)
})

test('palette runs actions and jumps to sessions', async ({ page }) => {
  await open(page)
  await palette(page, 'split right')
  await expect(panes(page)).toHaveCount(2)

  await page.keyboard.press('Meta+k')
  await page.getByRole('dialog').getByRole('textbox').fill('zzzz-nothing')
  await expect(page.getByRole('dialog')).toContainText('No matches')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await palette(page, 'Review #405')
  await expect(activeRow(page)).toContainText('Review #405')
})

test('sidebar toggles from the title bar and the keyboard', async ({ page }) => {
  await open(page)
  const sidebar = page.locator('.side')
  await expect(sidebar).toBeVisible()
  await page.getByRole('button', { name: /^Hide sessions/ }).click()
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole('button', { name: /^Show sessions/ })).toBeVisible()
  await page.keyboard.press('Meta+Backslash')
  await expect(sidebar).toBeVisible()
})

test('horizontal tabs replace the sidebar and switch tabs', async ({ page }) => {
  await open(page)
  const count = await tabRows(page).count()
  await palette(page, 'toggle tabs')
  await expect(page.locator('.side')).toBeHidden()
  const tabs = page.locator('.htab')
  await expect(tabs).toHaveCount(count)
  await tabs.filter({ hasText: 'Review #405' }).click()
  await expect(page.locator('.htab.on')).toContainText('Review #405')
  // Survives a reload: the layout is the daemon's UI blob
  await persisted(page, '"orientation":"horizontal"')
  await page.reload()
  await expect(page.locator('.htab.on')).toContainText('Review #405')
})

test('theme toggles and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-mode', 'dark')
  await page.getByRole('button', { name: 'Light theme' }).click()
  await expect(html).toHaveAttribute('data-mode', 'light')
  await expect(page.getByRole('button', { name: 'Dark theme' })).toBeVisible()
  await persisted(page, '"theme":"light"')
  await page.reload()
  await expect(html).toHaveAttribute('data-mode', 'light')
})

test('a daemon restart shows the reconnect banner until it is back', async ({ page }) => {
  await open(page)
  const banner = page.getByText('Reconnecting to the terminal host')
  await expect(banner).toBeHidden()
  await page.evaluate(() => window.treeixMock?.restart())
  await expect(banner).toBeVisible()
  await expect(banner).toBeHidden({ timeout: 5000 })
  await expect(terminal(page).first()).toBeVisible()
})

test('first run welcomes and starts a shell', async ({ page }) => {
  await page.goto('/?seed=empty')
  await expect(page.locator('.welcome')).toBeVisible()
  await expect(panes(page)).toHaveCount(0)
  await page.locator('.welcome').getByRole('button', { name: /shell/i }).first().click()
  await expect(page.locator('.welcome')).toBeHidden()
  await expect(panes(page)).toHaveCount(1)
  await expect(tabRows(page)).toHaveCount(1)
})

test('the quick terminal shortcut records the § key', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: /^Settings/ }).first().click()
  await page.getByPlaceholder('Search settings').fill('quick terminal')
  const recorder = page.getByRole('button', { name: 'Quick terminal shortcut' })
  await recorder.click()
  // Playwright has no IntlBackslash key, so the event WebKit sends for § goes in by hand
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '§', code: 'IntlBackslash', ctrlKey: true })))
  await expect(recorder).toHaveText('⌃§')
  await persisted(page, 'Control+IntlBackslash')
})
