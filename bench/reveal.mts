// Frontend-only reveal cost and xterm throughput in headless Chromium and WebKit: `node bench/reveal.mts`. Prints one JSON line
import { execFileSync } from 'node:child_process'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

const out = '/tmp/treeix-bench/web'
execFileSync('bun', ['build', resolve(import.meta.dirname, 'reveal-page.ts'), '--outdir', out, '--target', 'browser'], { stdio: 'ignore' })
// Inlined: Chromium won't load module scripts from file://
const inline = (name: string): string => readFileSync(join(out, name), 'utf8').replaceAll('</script', '<\\/script')
writeFileSync(join(out, 'index.html'), `<!doctype html><style>${inline('reveal-page.css')}</style><body><script type="module">${inline('reveal-page.js')}</script>`)
const playwright = createRequire(resolve(import.meta.dirname, '../apps/desktop/package.json'))('@playwright/test') as typeof import('@playwright/test')

// Over http so the page can fetch the bench inputs (100 MB through Playwright's route.fulfill stalls WebKit)
const server = createServer((req, res) => {
  const name = basename(req.url ?? '')
  createReadStream(name === 'index.html' ? join(out, name) : join(out, '..', name))
    .on('error', () => res.writeHead(404).end())
    .pipe(res)
}).listen(0, '127.0.0.1')
await new Promise((ready) => server.once('listening', ready))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const results: Record<string, unknown> = {}
for (const name of ['chromium', 'webkit'] as const) {
  try {
    const browser = await playwright[name].launch()
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(`${origin}/index.html`)
    await page.waitForFunction(() => window.revealResult !== undefined, null, { timeout: 600_000 })
    const webgl2 = await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null)
    results[name] = { ...(await page.evaluate(() => window.revealResult as object)), webgl2 }
    await browser.close()
  } catch (error) {
    results[name] = { error: String(error).split('\n')[0] }
  }
}
server.close()
console.log(JSON.stringify(results))
