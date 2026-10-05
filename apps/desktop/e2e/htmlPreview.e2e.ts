import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

const page = '<link rel="stylesheet" href="style.css"><h1 id="title">static</h1><script>document.getElementById("title").textContent = "scripted"</script>'

test.beforeAll(async () => {
  launched = await launch({ 'page.html': page, 'style.css': 'h1 { color: rgb(255, 0, 0) }' }, 'page.html')
})
test.afterAll(() => launched.close())

test('an HTML file previews as a page that runs its scripts and loads its relative CSS', async () => {
  const { app, page: window } = launched
  await window.getByRole('button', { name: 'Preview page' }).click()
  await expect(window.locator('webview')).toBeVisible()
  // The page lives in its own guest, so it is read from main
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview' && contents.getURL().endsWith('/page.html'))
        return guest?.executeJavaScript('((h1) => `${h1.textContent} ${getComputedStyle(h1).color}`)(document.querySelector("h1"))').catch(() => null)
      })
    )
    .toBe('scripted rgb(255, 0, 0)')

  await window.getByRole('button', { name: 'Show source' }).click()
  await expect(window.locator('webview')).toHaveCount(0)
})
