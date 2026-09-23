/**
 * Stress cases for the real app, driven over the Chrome DevTools Protocol, with frame and long-task numbers per case.
 *
 *   bun run --cwd apps/desktop stress                 builds, then runs every case
 *   bun apps/desktop/scripts/stress.ts [case…] [--open]   the last build; --open leaves the window up to poke at
 *
 * Cases: window-zoom, idle, terminal-flood, many-terminals, page-switching, page-keepalive, browser-tabs, split-toggle, palette-and-folder-picker.
 *
 * Runs its own window with a throwaway HOME and user data, so nothing of yours is touched and every run starts clean.
 * A case fails when its slowest frame or its p95 frame goes over the case's budget; the exit code says whether any did.
 * The window has to stay visible: hidden, Chromium stops painting and every frame number reads as zero.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')
const port = Number(process.env.STRESS_PORT ?? 9335)
const endpoint = `http://127.0.0.1:${port}`
const argv = process.argv.slice(2)
const keepOpen = argv.includes('--open')
const only = argv.filter((name) => !name.startsWith('--'))

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
type Json = Record<string, unknown>
const object = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})

async function pageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const list: unknown = await fetch(`${endpoint}/json/list`).then((response) => response.json()).catch(() => [])
    const page = (Array.isArray(list) ? list.map(object) : []).find((target) => target.type === 'page' && String(target.url).includes('index.html'))
    if (page) return String(page.webSocketDebuggerUrl)
    await sleep(200)
  }
  throw new Error('no app window on the debugging port')
}

async function connect(url: string): Promise<(method: string, params?: Json) => Promise<Json>> {
  const socket = new WebSocket(url)
  const waiting = new Map<number, { resolve: (value: Json) => void; reject: (reason: Error) => void }>()
  let nextId = 1
  await new Promise<void>((ready, failed) => {
    socket.addEventListener('open', () => ready(), { once: true })
    socket.addEventListener('error', () => failed(new Error('devtools socket failed')), { once: true })
  })
  socket.addEventListener('close', () => {
    for (const entry of waiting.values()) entry.reject(new Error('devtools socket closed'))
    waiting.clear()
  })
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const message = object(JSON.parse(event.data))
    const entry = typeof message.id === 'number' ? waiting.get(message.id) : undefined
    if (!entry) return
    waiting.delete(Number(message.id))
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(object(message.result))
  })
  return (method, params = {}) =>
    new Promise<Json>((done, fail) => {
      const id = nextId++
      waiting.set(id, { resolve: done, reject: fail })
      socket.send(JSON.stringify({ id, method, params }))
    })
}

const electronBinary = async (): Promise<string> => join(appDir, 'node_modules/electron/dist', (await readFile(join(appDir, 'node_modules/electron/path.txt'), 'utf8')).trim())

/** A throwaway home with two small repositories, one with a worktree, so pickers and the sidebar have something to list */
async function fakeHome(): Promise<string> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-stress-')))
  const git = (cwd: string, ...args: string[]): void => {
    Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'ignore', stderr: 'ignore' })
  }
  for (const name of ['alpha', 'beta']) {
    const repo = join(home, 'code', name)
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'README.md'), `# ${name}\n`)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, '-c', 'user.name=Stress', '-c', 'user.email=stress@treeix.dev', 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  git(join(home, 'code', 'alpha'), 'worktree', 'add', '-q', '-b', 'feat/stress', join(home, 'code', 'alpha-stress'))
  return home
}

/** Pages for the browser cases: a heavy one that keeps animating, a 404, and a port nothing listens on */
function pageServer(): { url: string; refused: string; stop: () => void } {
  const rows = Array.from({ length: 3000 }, (_, index) => `<li style="padding:2px">row ${index} <b>${'x'.repeat(index % 40)}</b></li>`).join('')
  const heavy = `<!doctype html><title>Heavy</title><body style="background:#111;color:#ddd;font:12px system-ui"><div id="tick"></div><ul>${rows}</ul>
<script>let n=0;setInterval(()=>{document.getElementById('tick').textContent='tick '+(n++);console.log('tick',n)},16)</script>`
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === '/missing') return new Response('<title>Missing</title>gone', { status: 404, headers: { 'content-type': 'text/html' } })
      return new Response(heavy, { headers: { 'content-type': 'text/html' } })
    }
  })
  // A port that just closed answers nothing; low ports like 1 are blocked by Chromium outright, a different error
  const closed = Bun.serve({ port: 0, fetch: () => new Response('') })
  const refused = `http://localhost:${closed.port}`
  void closed.stop(true)
  return { url: `http://localhost:${server.port}`, refused, stop: () => void server.stop(true) }
}

/** Collected in the page: every frame gap and every long task since the last reset */
const HARNESS = `(() => {
  if (window.__stress) return
  const stress = { frames: [], longTasks: [], last: 0 }
  window.__stress = stress
  new PerformanceObserver((list) => list.getEntries().forEach((entry) => stress.longTasks.push(entry.duration))).observe({ type: 'longtask' })
  const tick = (now) => {
    if (stress.last) stress.frames.push(now - stress.last)
    stress.last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

type Numbers = { maxFrame: number; p95Frame: number; frames: number; longTasks: number; longTaskMs: number }
type Budget = { maxFrame: number; p95Frame: number }
type Result = { name: string; ms: number; numbers: Numbers; budget: Budget; checks: string[]; failed: string[] }

type Driver = {
  evaluate: (expression: string) => Promise<unknown>
  until: (expression: string, ms?: number) => Promise<void>
  press: (code: string, modifiers?: { meta?: boolean; shift?: boolean; alt?: boolean }) => Promise<void>
  type: (text: string, enter?: boolean) => Promise<void>
  frames: () => Promise<unknown>
  pages: { heavy: string; missing: string; refused: string }
}

type Case = { name: string; budget: Budget; run: (driver: Driver) => Promise<string[]> }

const clickTitle = (title: string): string => `document.querySelector('button[title^=${JSON.stringify(title)}]')?.click()`
const typeAddress = (url: string): string => `(() => {
  const input = document.querySelector('input[placeholder="Search or type an address"]')
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`
const browserTabs = `document.querySelectorAll('[data-browser] [aria-label="Close tab"]').length`
const FLOOD = 'for i in $(seq 1 200000); do echo "line $i the quick brown fox jumps over the lazy dog 0123456789"; done'

/** Sessions open, from the count on the Terminal tab; only the shown tab's terminals are in the DOM */
const SESSIONS = `Number(document.querySelector('button[title^="Terminal"]')?.innerText.match(/\\d+/)?.[0] ?? 0)`

/** A new shell, as a tab or a split pane of the group on screen, focused and ready for input */
async function newShell(driver: Driver, split = false): Promise<void> {
  const before = Number(await driver.evaluate(SESSIONS))
  await driver.press(split ? 'KeyD' : 'KeyT', { meta: true })
  await driver.until(`${SESSIONS} > ${before} && document.activeElement?.classList.contains('xterm-helper-textarea')`)
  await sleep(400)
}

/** A colored full-screen redraw many times over, like a busy agent's TUI */
const COLOR_REDRAW = `for i in $(seq 1 300); do printf '\\033[H'; for j in $(seq 1 40); do printf '\\033[3%dm%04d \\033[1mEnforcing\\033[0m that \\033[32mlimit\\033[0m against \\033[35mdeposits\\033[0m %s\\033[K\\n' $((j%7+1)) $i $RANDOM; done; done`

/** Settings apply on load, so the theme is written and the window reloaded; `null` puts back the default */
async function reloadWithTheme(driver: Driver, theme: string | null): Promise<void> {
  await driver.evaluate(`(() => { const settings = JSON.parse(localStorage.getItem('settings') ?? '{}'); if (${JSON.stringify(theme)} === null) delete settings.theme; else settings.theme = ${JSON.stringify(theme)}; localStorage.setItem('settings', JSON.stringify(settings)); location.reload() })()`)
  await sleep(1500)
  await driver.until(`!!document.querySelector('[data-zone]')`, 30_000)
  await sleep(1500)
  await driver.evaluate(`window.confirm = () => true`)
  await driver.evaluate(HARNESS)
  // The run reads the frames painted during the case, and the reload started them over
  await sleep(500)
}

const CASES: Case[] = [
  {
    name: 'window-zoom',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // A zoomed window lays out at a different css width, which is how each key is checked
      const width = (): Promise<number> => driver.evaluate(`document.documentElement.clientWidth`).then(Number)
      const normal = await width()
      await driver.press('Equal', { meta: true })
      const zoomedIn = await width()
      await driver.press('Equal', { meta: true, shift: true })
      const plus = await width()
      await driver.press('Digit0', { meta: true })
      const reset = await width()
      await driver.press('Minus', { meta: true })
      const zoomedOut = await width()
      await driver.press('Digit0', { meta: true })
      return [
        zoomedIn < normal ? '⌘= zooms in' : 'FAIL ⌘= did nothing',
        plus < zoomedIn ? '⌘+ zooms in' : 'FAIL ⌘+ did nothing',
        reset === normal ? '⌘0 goes back to normal' : `FAIL ⌘0 left the window at ${reset} not ${normal}`,
        zoomedOut > normal ? '⌘- zooms out' : 'FAIL ⌘- did nothing'
      ]
    }
  },
  {
    name: 'idle',
    budget: { maxFrame: 120, p95Frame: 20 },
    run: async (driver) => {
      await driver.evaluate(clickTitle('Terminal'))
      await sleep(5000)
      return []
    }
  },
  {
    name: 'terminal-flood',
    budget: { maxFrame: 400, p95Frame: 34 },
    run: async (driver) => {
      await driver.evaluate(clickTitle('Terminal'))
      await driver.press('KeyT', { meta: true, shift: true })
      await driver.until(`document.activeElement?.classList.contains('xterm-helper-textarea')`)
      await sleep(600)
      await driver.type(FLOOD)
      await sleep(1500)
      // Input stays snappy while the output pours in: a page switch round trip under load
      const started = Date.now()
      await driver.evaluate(clickTitle('Browser'))
      await driver.frames()
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      const switchMs = Date.now() - started
      await sleep(6000)
      const renderer = await driver.evaluate(`[document.querySelectorAll('.xterm canvas').length, document.querySelectorAll('.xterm-rows').length].join('/')`)
      return [`page switch under load ${switchMs} ms`, `canvases/dom rows ${renderer}`]
    }
  },
  {
    name: 'many-terminals',
    budget: { maxFrame: 600, p95Frame: 50 },
    run: async (driver) => {
      await driver.evaluate(clickTitle('Terminal'))
      // Twenty tabs, then six panes side by side all printing at once, each with its own GPU context
      for (let index = 0; index < 20; index++) {
        await newShell(driver)
        await driver.type('yes "stress output line" | head -n 30000')
      }
      for (let index = 0; index < 5; index++) {
        await newShell(driver, true)
        await driver.type('yes "split pane output" | head -n 100000')
      }
      await sleep(5000)
      const sessions = await driver.evaluate(SESSIONS)
      const shown = await driver.evaluate(`document.querySelectorAll('.xterm').length`)
      const gpu = await driver.evaluate(`[...document.querySelectorAll('.xterm')].filter((element) => element.querySelector('canvas')).length`)
      return [`${sessions} sessions, ${shown} panes on screen, ${gpu} of them on the GPU renderer`]
    }
  },
  {
    name: 'page-switching',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      const titles = ['Terminal', 'Browser', 'Pull requests', 'Worktrees', 'Env']
      const timings: number[] = []
      for (let round = 0; round < 10; round++) {
        for (const title of titles) {
          const started = performance.now()
          await driver.evaluate(clickTitle(title))
          await driver.frames()
          timings.push(performance.now() - started)
        }
      }
      timings.sort((a, b) => a - b)
      // A terminal hidden by keep-alive is a zero-sized box; coming back must size it again
      await driver.evaluate(clickTitle('Terminal'))
      await newShell(driver)
      const shown = Number(await driver.evaluate(`Math.round(document.querySelector('.xterm canvas')?.getBoundingClientRect().width ?? 0)`))
      await driver.evaluate(clickTitle('Browser'))
      await driver.frames()
      await sleep(600)
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      await sleep(800)
      const back = Number(await driver.evaluate(`Math.round(document.querySelector('.xterm canvas')?.getBoundingClientRect().width ?? 0)`))
      return [
        `switch p50 ${Math.round(timings[Math.floor(timings.length / 2)])} ms, p95 ${Math.round(timings[Math.floor(timings.length * 0.95)])} ms (incl. CDP round trip)`,
        back > 100 ? `terminal is sized after coming back (${shown} px, then ${back} px)` : `FAIL terminal came back ${back} px wide`
      ]
    }
  },
  {
    name: 'page-keepalive',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // A mark on the page's own DOM survives only while the page stays mounted
      await driver.evaluate(clickTitle('Pull requests'))
      await driver.frames()
      await sleep(1500)
      const pageZone = `[...document.querySelectorAll('[data-zone="main"]')].filter((zone) => zone.checkVisibility()).at(-1)`
      // Marked on the page's content too: its main zone can survive while what sits inside it is rebuilt
      await driver.evaluate(`(${pageZone}.dataset.stressMark = 'kept', ${pageZone}.querySelector('*').dataset.stressMark = 'kept')`)
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      await sleep(600)
      await driver.evaluate(`(() => { if (window.__revisit) return; window.__revisit = []; new PerformanceObserver((list) => list.getEntries().forEach((entry) => window.__revisit.push(entry.duration))).observe({ type: 'longtask' }) })()`)
      await driver.evaluate(`window.__revisit = []`)
      await driver.evaluate(clickTitle('Pull requests'))
      await driver.frames()
      await sleep(1500)
      const kept = await driver.evaluate(`${pageZone}?.querySelector('*')?.dataset.stressMark ?? ''`)
      const blocked = Math.round(Number(await driver.evaluate(`(window.__revisit ?? []).reduce((sum, value) => sum + value, 0)`)))
      // With the bottom terminal open, the dock has to be drawn once, around the page on screen
      await driver.press('KeyJ', { meta: true })
      await driver.frames()
      await sleep(800)
      const docks = Number(await driver.evaluate(`document.querySelectorAll('[data-dock-frame]').length`))
      await driver.press('KeyJ', { meta: true })
      return [
        kept === 'kept' ? 'the page came back mounted' : 'FAIL the page was rebuilt',
        blocked <= 120 ? `revisit blocked ${blocked} ms` : `FAIL revisit blocked ${blocked} ms`,
        docks === 1 ? 'one dock frame with several pages kept' : `FAIL ${docks} dock frames`
      ]
    }
  },
  {
    name: 'terminal-return',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // A terminal docked on another page shows the same session; coming back, the Terminal page has to take it back
      await driver.evaluate(clickTitle('Terminal'))
      await newShell(driver)
      await driver.evaluate(clickTitle('Pull requests'))
      await sleep(600)
      await driver.press('KeyJ', { meta: true })
      await sleep(800)
      await driver.press('KeyJ', { meta: true })
      await driver.evaluate(clickTitle('Terminal'))
      await driver.frames()
      await sleep(800)
      const shown = await driver.evaluate(`[...document.querySelectorAll('[data-session-id] .xterm-screen')].some((screen) => screen.checkVisibility() && screen.getBoundingClientRect().width > 0)`)
      return [shown ? 'the Terminal page shows its terminal again' : 'FAIL the Terminal page came back empty']
    }
  },
  {
    name: 'light-terminal',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // Light themes keep the GPU renderer; the DOM one made busy agent sessions lag
      const theme = String(await driver.evaluate(`JSON.parse(localStorage.getItem('settings') ?? '{}').theme ?? ''`))
      await reloadWithTheme(driver, 'light')
      await newShell(driver)
      await driver.evaluate(`(window.__stress.frames = [], window.__stress.longTasks = [], window.__stress.last = 0)`)
      await driver.type(COLOR_REDRAW)
      await sleep(6000)
      const gpu = await driver.evaluate(`[...document.querySelectorAll('[data-session-id] .xterm')].some((terminal) => terminal.checkVisibility() && terminal.querySelector('canvas'))`)
      const frames = (await driver.evaluate(`window.__stress.frames`)) as number[]
      await reloadWithTheme(driver, theme || null)
      const slow = frames.filter((gap) => gap > 50).length
      return [gpu ? 'light theme draws with WebGL' : 'FAIL light theme fell back to the DOM renderer', slow <= 5 ? `${slow} frames over 50 ms while redrawing` : `FAIL ${slow} frames over 50 ms while redrawing`]
    }
  },
  {
    name: 'browser-keeps-size',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      // Shrinking a hidden page to nothing made every site lay itself out again, a visible jump on each switch back
      await driver.evaluate(clickTitle('Browser'))
      await sleep(500)
      await driver.evaluate(typeAddress(driver.pages.heavy))
      await sleep(2500)
      const size = `JSON.stringify([...document.querySelectorAll('webview')].map((view) => { const r = view.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }))`
      const shown = String(await driver.evaluate(size))
      await driver.evaluate(clickTitle('Terminal'))
      await sleep(800)
      const hidden = String(await driver.evaluate(size))
      const covered = await driver.evaluate(`[...document.querySelectorAll('[data-browser]')].some((layer) => layer.style.position === 'fixed' && getComputedStyle(layer).visibility === 'visible')`)
      await driver.evaluate(clickTitle('Browser'))
      await sleep(400)
      await driver.evaluate(`document.querySelectorAll('[data-browser] [aria-label="Close tab"]').forEach((button) => button.click())`)
      return [
        hidden === shown ? `the page kept its size off screen, ${shown}` : `FAIL the page went from ${shown} to ${hidden} off screen`,
        covered ? 'FAIL the hidden page layer is visible over the Terminal page' : 'the page layer stays hidden off screen'
      ]
    }
  },
  {
    name: 'browser-tabs',
    budget: { maxFrame: 500, p95Frame: 50 },
    run: async (driver) => {
      await driver.evaluate(clickTitle('Browser'))
      await sleep(400)
      const urls = [...Array.from({ length: 12 }, (_, index) => `${driver.pages.heavy}/?tab=${index}`), driver.pages.missing, driver.pages.refused]
      let errorPage = false
      for (const url of urls) {
        await driver.evaluate(`document.querySelector('[data-browser] button[aria-label="New tab"]').click()`)
        await sleep(150)
        await driver.evaluate(typeAddress(url))
        await sleep(350)
        if (url === driver.pages.refused) {
          await sleep(1500)
          errorPage = Boolean(await driver.evaluate(`document.body.innerText.includes('Nothing is answering')`))
        }
      }
      await sleep(2500)
      const opened = Number(await driver.evaluate(browserTabs))
      // Every tab once, then close ten and bring them back with ⌘⇧T, focus on the body as after a click on ×
      for (let index = 0; index < opened; index++) await driver.evaluate(`document.querySelectorAll('[data-browser] .group.flex.h-6')[${index}]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      for (let index = 0; index < 10; index++) await driver.evaluate(`document.querySelector('[data-browser] [aria-label="Close tab"]').click()`)
      await driver.evaluate(`document.activeElement?.blur()`)
      const afterClose = Number(await driver.evaluate(browserTabs))
      for (let index = 0; index < 10; index++) await driver.press('KeyT', { meta: true, shift: true })
      await sleep(2000)
      const reopened = Number(await driver.evaluate(browserTabs))
      const checks = [`${opened} tabs, ${afterClose} after closing ten, ${reopened} after ⌘⇧T ×10`, errorPage ? 'refused port shows the error page' : 'FAIL no error page for the refused port']
      if (reopened !== opened) checks.push('FAIL ⌘⇧T did not bring every closed tab back')
      return checks
    }
  },
  {
    name: 'split-toggle',
    budget: { maxFrame: 300, p95Frame: 34 },
    run: async (driver) => {
      // Through the palette, as a user would: the browser beside the terminal, a swap, then closed again
      await driver.evaluate(clickTitle('Terminal'))
      const palette = async (text: string): Promise<void> => {
        await driver.press('KeyK', { meta: true })
        // Typed before the palette takes focus, the text would land in the terminal behind it
        await driver.until(`document.activeElement?.placeholder?.startsWith('Search commands')`, 3000)
        // Enter only once the list has filtered, else it runs whatever row was on top before
        await driver.type(text, false)
        await driver.frames()
        await sleep(150)
        await driver.type('')
      }
      let shown = 0
      for (let round = 0; round < 10; round++) {
        await palette('Open browser in split')
        await driver.until(`!!document.querySelector('[data-split-pane]')`, 3000)
        shown++
        await driver.evaluate(clickTitle('Browser'))
        await driver.frames()
        await palette('Close split')
        await driver.until(`!document.querySelector('[data-split-pane]')`, 3000)
        await driver.evaluate(clickTitle('Terminal'))
        await driver.frames()
      }
      return [`split opened, swapped and closed ${shown} times`]
    }
  },
  {
    name: 'palette-and-folder-picker',
    budget: { maxFrame: 250, p95Frame: 34 },
    run: async (driver) => {
      for (let round = 0; round < 10; round++) {
        await driver.press('KeyK', { meta: true })
        await driver.until(`document.activeElement?.placeholder?.startsWith('Search commands')`, 3000)
        await driver.type('open', false)
        // The first Esc clears the query, the second closes the palette
        await driver.press('Escape')
        await driver.press('Escape')
        await driver.press('KeyO', { meta: true })
        await driver.until(`document.activeElement?.placeholder === 'Go to folder'`)
        await driver.type('feat alpha', false)
        await driver.press('Escape')
      }
      const stillOpen = await driver.evaluate(`document.querySelectorAll('input[placeholder="Go to folder"]').length`)
      // ⌘⇧P is the palette's second key, as in VS Code; the folder picker has ⌘O
      await driver.press('KeyP', { meta: true, shift: true })
      const palette = Boolean(await driver.evaluate(`document.activeElement?.placeholder?.startsWith('Search commands')`))
      await driver.press('Escape')
      // Two words in any order find the one worktree that has both
      await driver.press('KeyO', { meta: true })
      await driver.until(`document.activeElement?.placeholder === 'Go to folder'`)
      await driver.type('feat alpha', false)
      await driver.frames()
      const matches = Number(await driver.evaluate(`document.activeElement.parentElement.querySelectorAll('button').length`))
      await driver.press('Escape')
      return [
        stillOpen === 0 ? 'pickers closed cleanly' : 'FAIL a picker stayed open',
        palette ? '⌘⇧P opens the palette' : 'FAIL ⌘⇧P did not open the palette',
        matches === 1 ? '"feat alpha" finds the one worktree' : `FAIL "feat alpha" matched ${matches} folders`
      ]
    }
  }
]

const percentile = (values: number[], share: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]
}

async function main(): Promise<void> {
  if (await fetch(`${endpoint}/json/version`).then(() => true, () => false)) throw new Error(`something already listens on ${endpoint}, quit it first`)
  const home = await fakeHome()
  const pages = pageServer()
  // Another window over this one would mark it hidden and stop its frames, which is every number this run reads
  const flags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
  const child = Bun.spawn([await electronBinary(), appDir, `--remote-debugging-port=${port}`, ...flags], {
    cwd: appDir,
    env: { ...process.env, HOME: home, TREEIX_USER_DATA: join(home, 'user-data') },
    stdout: 'ignore',
    stderr: 'ignore'
  })
  const results: Result[] = []
  try {
    const cdp = await connect(await pageTarget())
    await cdp('Runtime.enable')
    const evaluate = async (expression: string): Promise<unknown> => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(object(result.exceptionDetails).exception ?? result.exceptionDetails).slice(0, 200)}`)
      return object(result.result).value
    }
    const until = async (expression: string, ms = 15_000): Promise<void> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await evaluate(expression).catch(() => false)) return
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${expression}`)
    }
    // Two frames, or a second when nothing paints, so a hidden window fails its case instead of hanging the run
    const frames = (): Promise<unknown> => evaluate(`new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 1000) })`)
    // The app's keys are read from window keydown, which is where a key pressed in the window lands too
    const press = async (code: string, modifiers: { meta?: boolean; shift?: boolean; alt?: boolean } = {}): Promise<void> => {
      const name = code.startsWith('Key') ? code.slice(3).toLowerCase() : code
      await evaluate(
        `(document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)}, key: ${JSON.stringify(name)}, metaKey: ${!!modifiers.meta}, shiftKey: ${!!modifiers.shift}, altKey: ${!!modifiers.alt}, bubbles: true, cancelable: true }))`
      )
      await frames()
    }
    const type = async (text: string, enter = true): Promise<void> => {
      await cdp('Input.insertText', { text })
      if (enter) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    }
    await until(`!!document.querySelector('[data-zone]')`, 30_000)
    await cdp('Page.bringToFront')
    await sleep(2000)
    // Deleting groups and closing sessions asks first; a stress run always says yes
    await evaluate(`window.confirm = () => true`)
    await evaluate(HARNESS)
    const driver: Driver = { evaluate, until, press, type, frames, pages: { heavy: pages.url, missing: `${pages.url}/missing`, refused: pages.refused } }

    for (const stressCase of CASES.filter((candidate) => !only.length || only.includes(candidate.name))) {
      await evaluate(`(window.__stress.frames = [], window.__stress.longTasks = [], window.__stress.last = 0)`)
      const started = Date.now()
      let checks: string[]
      try {
        checks = await stressCase.run(driver)
      } catch (reason) {
        checks = [`FAIL ${reason instanceof Error ? reason.message : String(reason)}`]
      }
      const ms = Date.now() - started
      const visible = await evaluate('document.visibilityState')
      if (visible !== 'visible') checks.push(`FAIL window was ${String(visible)} during the case`)
      const collected = object(await evaluate(`({ frames: window.__stress.frames, longTasks: window.__stress.longTasks })`))
      const gaps = (collected.frames as number[]) ?? []
      const longTasks = (collected.longTasks as number[]) ?? []
      const numbers: Numbers = {
        maxFrame: Math.round(Math.max(0, ...gaps)),
        p95Frame: Math.round(percentile(gaps, 0.95)),
        frames: gaps.length,
        longTasks: longTasks.length,
        longTaskMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0))
      }
      const failed = [
        ...(numbers.maxFrame > stressCase.budget.maxFrame ? [`slowest frame ${numbers.maxFrame} ms > ${stressCase.budget.maxFrame}`] : []),
        ...(numbers.p95Frame > stressCase.budget.p95Frame ? [`p95 frame ${numbers.p95Frame} ms > ${stressCase.budget.p95Frame}`] : []),
        ...(numbers.frames === 0 ? ['no frames painted: is the window hidden?'] : []),
        ...checks.filter((check) => check.startsWith('FAIL')).map((check) => check.slice(5))
      ]
      const result: Result = { name: stressCase.name, ms, numbers, budget: stressCase.budget, checks: checks.filter((check) => !check.startsWith('FAIL')), failed }
      results.push(result)
      console.log(
        `${failed.length ? 'FAIL' : 'ok  '} ${result.name.padEnd(26)} ${String(ms).padStart(6)} ms  frames ${numbers.frames}  max ${numbers.maxFrame} ms  p95 ${numbers.p95Frame} ms  long tasks ${numbers.longTasks} (${numbers.longTaskMs} ms)`
      )
      for (const check of result.checks) console.log(`       ${check}`)
      for (const reason of failed) console.log(`       ✗ ${reason}`)
    }
    if (keepOpen) {
      console.log('Left open; Ctrl-C to quit')
      await new Promise(() => undefined)
    }
  } finally {
    child.kill()
    pages.stop()
    await sleep(500)
    await rm(home, { recursive: true, force: true })
  }
  if (results.some((result) => result.failed.length)) process.exit(1)
}

await main()
