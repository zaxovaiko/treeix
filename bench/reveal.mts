// Frontend reveal cost in headless Chromium and WebKit: `node bench/reveal.mts`. Prints one JSON line
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const out = '/tmp/treeix-bench/web'
execFileSync('bun', ['build', resolve(import.meta.dirname, 'reveal-page.ts'), '--outdir', out, '--target', 'browser'], { stdio: 'ignore' })
// Inlined: Chromium won't load module scripts from file://
const inline = (name: string): string => readFileSync(join(out, name), 'utf8').replaceAll('</script', '<\\/script')
writeFileSync(join(out, 'index.html'), `<!doctype html><style>${inline('reveal-page.css')}</style><body><script type="module">${inline('reveal-page.js')}</script>`)
const playwright = createRequire(resolve(import.meta.dirname, '../apps/desktop/package.json'))('@playwright/test') as typeof import('@playwright/test')

const results: Record<string, unknown> = {}
for (const name of ['chromium', 'webkit'] as const) {
  try {
    const browser = await playwright[name].launch()
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(`file://${out}/index.html`)
    await page.waitForFunction(() => window.revealResult !== undefined, null, { timeout: 120_000 })
    const webgl2 = await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null)
    results[name] = { ...(await page.evaluate(() => window.revealResult as object)), webgl2 }
    await browser.close()
  } catch (error) {
    results[name] = { error: String(error).split('\n')[0] }
  }
}
console.log(JSON.stringify(results))
