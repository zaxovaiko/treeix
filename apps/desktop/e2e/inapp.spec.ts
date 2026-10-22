import { expect, test } from '@playwright/test'
import type { E2eReport } from '../src/e2e/run'

// The in-app runner (TREEIX_AUTORUN=e2e, src/e2e) on the mock daemon: proves its selectors and steps headless.
// Same module URLs as the app's, so it taps the very api object the shell renders with
test('the in-app e2e passes on the mock', async ({ page }) => {
  await page.goto('/?seed=empty')
  await expect(page.locator('.welcome')).toBeVisible()
  // A string, so the imports stay the browser's own and are not transpiled for node
  const report = await page.evaluate<E2eReport>(`Promise.all([import('/src/ipc/api.ts'), import('/src/e2e/index.ts')]).then(async ([m, e2e]) => e2e.runE2e(await m.api()))`)
  expect(report.failed).toEqual([])
  expect(report.passed).toHaveLength(9)
})
