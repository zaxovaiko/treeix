// Electron app throughput: `node bench/electron.ts <file> <runs>` after `electron-vite build` in apps/desktop.
// Drives the built app with Playwright on a throwaway HOME, runs `cat <file>` in a shell and times Enter until xterm
// has parsed the title escape printed right after the file (renderer clock). Prints one JSON line.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '../apps/desktop')
const { _electron: electron } = createRequire(join(desktop, 'package.json'))('@playwright/test') as typeof import('@playwright/test')

const file = process.argv[2] ?? '/tmp/treeix-bench/mixed-100m.ans'
const runs = Number(process.argv[3] ?? 5)

const home = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-bench-')))
const repo = join(home, 'code', 'alpha')
mkdirSync(repo, { recursive: true })
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

// Same launch as apps/desktop/e2e/app.ts; TREEIX_HEADLESS turns background throttling off for the hidden window
const app = await electron.launch({
  args: [desktop, '-ApplePersistenceIgnoreState', 'YES'],
  cwd: desktop,
  env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data'), TREEIX_HEADLESS: '1', SHELL: '/bin/zsh' }
})
try {
  const page = await app.firstWindow()
  await page.getByPlaceholder('Search').first().waitFor({ timeout: 30_000 })
  const shell = page.getByRole('button', { name: /Shell$/ })
  for (let i = 0; i < 30 && !(await shell.isVisible()); i++) {
    await page.keyboard.press('Meta+j')
    await page.waitForTimeout(1000)
  }
  await shell.click()
  await page.locator('.xterm').first().waitFor()
  await page.waitForTimeout(2000)
  await page.locator('.xterm').first().click()

  const seconds: number[] = []
  for (let run = 1; run <= runs; run++) {
    const marker = `bench-done-${run}`
    await page.keyboard.insertText(`clear; cat ${file}; printf '\\033]0;${marker}\\007'`)
    // The title only reaches the DOM once xterm parsed every byte before it
    const done = page.evaluate(
      (marker) =>
        new Promise<number>((resolve) => {
          let start = 0
          window.addEventListener('keydown', () => (start = performance.now()), { capture: true, once: true })
          const observer = new MutationObserver(() => {
            if (!document.body.textContent?.includes(marker)) return
            observer.disconnect()
            resolve((performance.now() - start) / 1000)
          })
          observer.observe(document.body, { subtree: true, childList: true, characterData: true })
        }),
      marker
    )
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    seconds.push(await done)
    await page.waitForTimeout(1000)
  }
  const mb = statSync(file).size / 1024 / 1024
  const sorted = [...seconds].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(JSON.stringify({ file, mb, runs: seconds, medianSeconds: median, mbPerSecond: mb / median }))
} finally {
  await app.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
