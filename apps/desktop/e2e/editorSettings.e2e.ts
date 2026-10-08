import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'notes.md': Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') }, 'notes.md')
})
test.afterAll(() => launched.close())

test('the minimap hides from the palette and shows again from the Editor settings page', async () => {
  const { page } = launched
  const minimap = page.locator('.monaco-editor .minimap')
  await expect(minimap).toBeVisible()

  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByPlaceholder(/^Search commands/).fill('minimap')
  await page.getByRole('button', { name: 'Hide editor minimap' }).click()
  await expect(minimap).toBeHidden()

  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByRole('switch', { name: 'Minimap' }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}'))).toMatchObject({ editorMinimap: true })
})

test("word wrap turns on and off from the editor's right-click menu", async () => {
  const { app, page } = launched
  // Native menus can't be clicked from the page, so the main process picks Word wrap and keeps what each menu showed
  await app.evaluate(({ ipcMain }) => {
    const shown: { label?: string; checked?: boolean }[][] = []
    Object.assign(globalThis, { shownMenus: shown })
    ipcMain.removeHandler('showContextMenu')
    ipcMain.handle('showContextMenu', (_, items: { id?: string; label?: string; checked?: boolean }[]) => {
      shown.push(items)
      return items.find((item) => item.label === 'Word wrap')?.id ?? null
    })
  })
  const wrapItem = (): Promise<boolean | undefined> =>
    app.evaluate(() => (globalThis as unknown as { shownMenus: { label?: string; checked?: boolean }[][] }).shownMenus.at(-1)?.find((item) => item.label === 'Word wrap')?.checked)
  const wordWrap = (): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}').editorWordWrap)
  await page.locator('[data-page-tab="worktrees"]').click({ modifiers: ['Shift'] })

  await page.locator('.monaco-editor .view-lines').click({ button: 'right' })
  await expect.poll(wordWrap).toBe(true)
  expect(await wrapItem()).toBe(false)
  await page.locator('.monaco-editor .view-lines').click({ button: 'right' })
  await expect.poll(wordWrap).toBe(false)
  expect(await wrapItem()).toBe(true)
})
