/**
 * Marketing screenshots, taken from the real app over the Chrome DevTools Protocol.
 *
 *   sh scripts/demo-home.sh /tmp/treeix-demo
 *   bun run --cwd apps/desktop build
 *   bun apps/desktop/scripts/shots.ts [name…]
 *
 * Electron runs with the demo home so the sidebar, terminals and pull requests show made-up work,
 * and the window stays visible: terminal statuses stop updating while the page is hidden.
 */
import { realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  confluenceState,
  ignoreEnvFixtures,
  jiraState,
  ORBIT_BILLING_PAGE,
  writeEnvFixtures,
  writeHubFixtures,
  writeLimitFixtures,
  writePullRequestFixtures
} from './shot-fixtures'

const appDir = resolve(import.meta.dir, '..')
const root = resolve(appDir, '../..')
// git reports worktrees by their real path, so /tmp/… would not match what the app shows
const home = realpathSync(process.env.DEMO_HOME ?? '/tmp/treeix-demo')
const outDir = process.env.SHOTS_OUT ?? join(root, 'marketing/shots')
const port = Number(process.env.SHOTS_PORT ?? 9333)
/** The billing page the browser scene opens; move it off 3000 when a dev server holds that port */
const WEB_PORT = Number(process.env.SHOTS_WEB_PORT ?? 3000)
const endpoint = `http://127.0.0.1:${port}`
const argv = process.argv.slice(2)
/** Opens the app on one scene and leaves it running, to check how a frame looks before shooting it */
const keepOpen = argv.includes('--open')
const only = argv.filter((name) => !name.startsWith('--'))
/** Same title bar in every scene (sessions, comments, usage limits), for shots shown one after another in a video */
const uniform = argv.includes('--uniform')

const repo = `${home}/code/orbit-web`
const invoices = `${repo}/.claude/worktrees/feat+usage-invoices`
const timeout = `${repo}/.claude/worktrees/fix+session-timeout`
const api = `${home}/code/orbit-api`

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

type Json = Record<string, unknown>
const object = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})

async function targets(): Promise<Json[]> {
  const response = await fetch(`${endpoint}/json/list`)
  const parsed: unknown = await response.json()
  return Array.isArray(parsed) ? parsed.map(object) : []
}

async function pageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await targets()
      .then((list) => list.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'))
      .catch(() => undefined)
    if (page) return String(page.webSocketDebuggerUrl)
    await sleep(200)
  }
  throw new Error('no page target on the debugging port')
}

/** A CDP connection: one socket, one promise per command */
async function connect(url: string): Promise<(method: string, params?: Json) => Promise<Json>> {
  const socket = new WebSocket(url)
  const waiting = new Map<number, { resolve: (value: Json) => void; reject: (reason: Error) => void }>()
  let nextId = 1
  await new Promise<void>((ready, failed) => {
    socket.addEventListener('open', () => ready(), { once: true })
    socket.addEventListener('error', () => failed(new Error('devtools socket failed')), { once: true })
  })
  // A window that quits mid-run would otherwise leave every pending command hanging forever
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
    new Promise<Json>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
}

const electronBinary = async (): Promise<string> => {
  const relative = (await readFile(join(appDir, 'node_modules/electron/path.txt'), 'utf8')).trim()
  return join(appDir, 'node_modules/electron/dist', relative)
}

/** Demo state the app reads at startup; every store is localStorage, so one evaluate plus a reload seeds the lot */
const session = (id: string, kind: string, title: string, worktreePath: string, minutesAgo: number): Json => ({
  id,
  kind,
  title,
  worktreePath,
  startedAt: Date.now() - minutesAgo * 60_000,
  workspaceId: 'all',
  agentSessionId: kind === 'claude' ? '0d1b6a58-96f4-4a0e-9d64-2f7c1c4c1f01' : null
})

function baseState(): Record<string, unknown> {
  return {
    settings: {
      themeMode: 'dark',
      darkTheme: 'neutral',
      diffStyle: 'split',
      sections: 'expanded',
      opacity: 100,
      borderStrength: 100,
      hotkey: null,
      sidebarBranches: false,
      digitShortcuts: { tabs: 'off', workspaces: 'altMeta' },
      editorFontSize: 13,
      terminalFontSize: 12,
      plugins: { 'usage-limits': false, jira: true, confluence: true }
    },
    'shell.panels': {
      rail: true,
      title: true,
      status: true,
      pages: { worktrees: { list: true, inspector: true, listWidth: 300, inspectorWidth: 280 }, terminal: { list: true, inspector: true, listWidth: 320, inspectorWidth: 280 } }
    },
    layout: {
      docks: { left: [], right: [], bottom: ['terminal'] },
      active: { left: null, right: null, bottom: null },
      hidden: ['terminal'],
      sizes: { left: 320, right: 380, bottom: 320 }
    },
    'app.place@all': { appTab: 'worktrees', selected: invoices, viewer: null },
    comments: [
      {
        id: 'c-1',
        worktreePath: invoices,
        filePath: 'src/billing/portal.ts',
        range: { start: 20, end: 25, side: 'additions' },
        code: '',
        text: 'Stripe paginates past 100 invoices. Use auto-pagination here so a busy account still lists everything.'
      }
    ]
  }
}

/** Sessions, seeded only for the terminal shot so the diff shots keep an empty dock */
function terminalState(): Record<string, unknown> {
  return {
    'terminals.saved': {
      sessions: [
        session('s-claude', 'claude', 'Billing invoices', invoices, 24),
        session('s-shell', 'shell', 'orbit-web', invoices, 24),
        session('s-codex', 'codex', 'Session timeout', timeout, 51),
        session('s-api', 'shell', 'orbit-api', `${home}/code/orbit-api`, 96)
      ],
      selected: { all: 's-claude' }
    },
    'terminals.history': [
      { ...session('s-old-1', 'claude', 'Invoice totals', invoices, 220), endedAt: Date.now() - 3 * 3_600_000 },
      { ...session('s-old-2', 'codex', 'Portal return path', invoices, 400), endedAt: Date.now() - 6 * 3_600_000 }
    ]
  }
}

const comment = (id: string, filePath: string, start: number, end: number, code: string, text: string): Json => ({
  id,
  worktreePath: invoices,
  filePath,
  range: { start, end, side: 'additions' },
  code,
  text
})

/** What --uniform lays over every scene: the terminal sessions, three queued comments and the usage limits pill */
function uniformState(state: Record<string, unknown>): Record<string, unknown> {
  const settings = object(state.settings ?? baseState().settings)
  return {
    ...terminalState(),
    ...state,
    settings: { ...settings, plugins: { ...object(settings.plugins), 'usage-limits': true } },
    'plugin.usage-limits.settings': { usageLabel: 'reset' },
    comments: [
      ...(baseState().comments as Json[]),
      comment('c-2', 'src/billing/portal.ts', 30, 36, '+function toInvoice(invoice: Stripe.Invoice): Invoice {', 'Write a unit test for toInvoice, an unpaid invoice included.'),
      comment(
        'c-3',
        'src/billing/invoices.test.ts',
        9,
        12,
        "+test('converts cents and keeps unpaid invoices', async () => {",
        'Add a refunded invoice, Stripe sends a negative total for it.'
      )
    ]
  }
}

/** The diff renders inside shadow roots, so waits have to walk into them like FileView.findLineElement does */
const DEEP = `(selector) => {
  const walk = (root) => {
    const hit = root.querySelector(selector)
    if (hit) return hit
    for (const element of root.querySelectorAll('*')) {
      const nested = element.shadowRoot && walk(element.shadowRoot)
      if (nested) return nested
    }
    return null
  }
  return walk(document)
}`

/** The repository scan is kept: without it the app starts with nothing selected and forgets the seeded worktree */
const SEED = `(state) => {
  const scan = localStorage.getItem('scan.cache')
  localStorage.clear()
  if (scan) localStorage.setItem('scan.cache', scan)
  for (const [key, value] of Object.entries(state)) localStorage.setItem(key, JSON.stringify(value))
}`

/** The traffic lights are native, so a page capture would show an empty gutter where they belong */
const TRAFFIC_LIGHTS = `() => {
  if (document.getElementById('shot-traffic')) return
  const bar = document.createElement('div')
  bar.id = 'shot-traffic'
  bar.style.cssText = 'position:fixed;top:13px;left:20px;display:flex;gap:8px;z-index:99999;pointer-events:none'
  bar.innerHTML = ['#ff5f57', '#febc2e', '#28c840'].map((color) => '<i style="width:12px;height:12px;border-radius:50%;display:block;background:' + color + '"></i>').join('')
  document.body.appendChild(bar)
}`

async function main(): Promise<void> {
  const busy = await fetch(`${endpoint}/json/version`).then(
    () => true,
    () => false
  )
  if (busy) throw new Error(`something already listens on ${endpoint}, quit it first`)
  await mkdir(outDir, { recursive: true })

  // The Browser scene's page, where the worktree's dev server would be
  await writePullRequestFixtures(home, repo, api, invoices)
  if (uniform) {
    await writeLimitFixtures(home)
    await writeEnvFixtures(repo, invoices)
    await ignoreEnvFixtures(repo)
  }
  const devServer =
    only.length && !only.includes('browser') ? null : Bun.serve({ port: WEB_PORT, fetch: () => new Response(ORBIT_BILLING_PAGE, { headers: { 'content-type': 'text/html' } }) })
  const child = Bun.spawn([await electronBinary(), appDir, `--remote-debugging-port=${port}`], {
    cwd: appDir,
    // macOS resolves appData from the real user, not HOME, so without this the demo run reads and writes your own data
    env: { ...process.env, HOME: home, TREEIX_USER_DATA: `${home}/Library/Application Support/Treeix`, PATH: `${home}/bin:${process.env.PATH ?? ''}` },
    stdout: 'ignore',
    stderr: 'ignore'
  })

  try {
    const cdp = await connect(await pageTarget())
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    // A locked screen or covered window marks the page hidden, which stops animation frames and every settle with them
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (!keepOpen) {
      // The whole screen, as a full-screen window would have: Electron has no CDP Browser domain to resize with,
      // and the accessibility route needs a permission a script can't grant itself.
      const display = await cdp('Runtime.evaluate', { expression: '[screen.width, screen.height]', returnByValue: true })
      // SHOTS_SIZE=1428x933 keeps a laptop screen's shots the size of the ones taken on the usual display
      const [width, height] = process.env.SHOTS_SIZE ? process.env.SHOTS_SIZE.split('x').map(Number) : (object(display.result).value as [number, number])
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
    }
    // The scan has to land before anything is seeded: a cold start with no repositories drops the saved worktree
    await sleep(1500)

    const evaluate = async (expression: string): Promise<unknown> => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      return object(result.result).value
    }
    const reload = async (): Promise<void> => {
      await cdp('Page.reload')
      await sleep(1200)
      await until(`!!document.querySelector('[data-zone]')`)
      // A window left open has its own real traffic lights; the fakes are only for captures
      if (!keepOpen) await evaluate(`(${TRAFFIC_LIGHTS})()`)
    }
    async function until(expression: string, ms = 15_000): Promise<void> {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await evaluate(expression).catch(() => false)) return
        await sleep(200)
      }
      throw new Error(`timed out waiting for ${expression}`)
    }
    const settle = async (ms = 400): Promise<void> => {
      await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`)
      await sleep(ms)
    }

    const virtualKey = (code: string): number => {
      if (code.startsWith('Key')) return code.charCodeAt(3)
      if (code.startsWith('Digit')) return code.charCodeAt(5)
      return { Escape: 27, Enter: 13, Slash: 191, BracketRight: 221, BracketLeft: 219, Space: 32 }[code] ?? 0
    }
    const key = async (name: string, code: string, modifiers = 0, text?: string): Promise<void> => {
      const common = { key: name, code, modifiers, windowsVirtualKeyCode: virtualKey(code), nativeVirtualKeyCode: virtualKey(code) }
      await cdp('Input.dispatchKeyEvent', { ...common, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text } : {}) })
      await cdp('Input.dispatchKeyEvent', { ...common, type: 'keyUp' })
      await settle(250)
    }
    const letter = (name: string, modifiers = 0): Promise<void> => key(name, `Key${name.toUpperCase()}`, modifiers, modifiers === 0 ? name : undefined)
    const clickText = async (selector: string, text: string): Promise<void> => {
      await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent?.includes(${JSON.stringify(text)}))?.click()`)
      await settle()
    }
    const shot = async (name: string): Promise<void> => {
      await cdp('Page.bringToFront')
      // A pointer left over from an earlier scene's drag would hover a row and pop a tooltip
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
      await settle()
      const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await Bun.write(join(outDir, `${name}.png`), Buffer.from(String(result.data), 'base64'))
      console.log(`  ${name}.png`)
    }

    const openDiff = async (): Promise<void> => {
      await until(`!!document.body.textContent?.includes('portal.ts')`)
      await clickText('button', 'portal.ts')
      await until(`(${DEEP})('[data-column-number]') !== null`)
      await settle(800)
    }

    /** Drags down the new-side line numbers, as a mouse would, to open a comment on the range */
    const dragLines = async (from: number, to: number): Promise<void> => {
      const centre = async (line: number): Promise<[number, number]> =>
        (await evaluate(
          `(() => { const cell = [...((${DEEP})('[data-column-number="${line}"]')?.getRootNode()?.querySelectorAll('[data-column-number="${line}"]') ?? [])].at(-1); const box = cell?.getBoundingClientRect(); return box ? [box.x + box.width / 2, box.y + box.height / 2] : [0, 0] })()`
        )) as [number, number]
      const [x1, y1] = await centre(from)
      const [x2, y2] = await centre(to)
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
      for (let step = 1; step <= 5; step++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 + ((y2 - y1) * step) / 5, button: 'left', buttons: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
      await settle(500)
    }

    await until(`!!localStorage.getItem('scan.cache')`, 30_000)

    const seed = async (state: Record<string, unknown>): Promise<void> => {
      await evaluate(`(${SEED})(${JSON.stringify(uniform ? uniformState(state) : state)})`)
      await reload()
    }

    // Each scene seeds its own state and reloads, so any one of them can be re-shot on its own
    const page = (appTab: string): Record<string, unknown> => ({ ...baseState(), ...terminalState(), 'app.place@all': { appTab, selected: invoices, viewer: null } })
    const scenes: { name: string; run: () => Promise<void> }[] = [
      {
        name: 'hero',
        run: async () => {
          await seed(baseState())
          await openDiff()
        }
      },
      {
        name: 'drawer',
        run: async () => {
          await seed({ ...baseState(), ...terminalState(), settings: { ...object(baseState().settings), diffStyle: 'unified' } })
          await openDiff()
          await letter('i', 4)
          await settle(500)
        }
      },
      {
        name: 'unified',
        run: async () => {
          await seed({ ...baseState(), ...terminalState(), settings: { ...object(baseState().settings), diffStyle: 'unified' } })
          await openDiff()
        }
      },
      {
        name: 'terminal',
        run: async () => {
          await seed(page('terminal'))
          // The panes run the fake claude and codex from the demo home, which take a moment to draw
          await until(`!!document.body.textContent?.includes('Billing invoices')`)
          await settle(2500)
        }
      },
      {
        name: 'tasks',
        run: async () => {
          await seed({ ...page('tasks'), ...jiraState() })
          await until(`!!document.body.textContent?.includes('ORB-142')`)
          await settle(800)
        }
      },
      {
        name: 'confluence',
        run: async () => {
          await seed({ ...page('confluence'), ...confluenceState() })
          await until(`!!document.body.textContent?.includes('Billing self-service')`)
          await settle(800)
        }
      },
      {
        name: 'diff',
        run: async () => {
          await seed({ ...baseState(), settings: { ...object(baseState().settings), diffStyle: 'unified' } })
          await openDiff()
          await dragLines(6, 10)
          await evaluate(`(() => { const box = (${DEEP})('textarea') ?? document.querySelector('textarea'); box?.focus() })()`)
          await cdp('Input.insertText', { text: 'Infer this type from the zod schema in lib/schemas instead of writing it by hand.' })
          await settle(500)
        }
      },
      {
        name: 'pr',
        run: async () => {
          await seed({ ...page('prs'), 'prs.selected@all': `${repo}#482` })
          await until(`!!document.body.textContent?.includes('Add to agent comments')`, 30_000)
          await settle(1200)
        }
      },
      {
        name: 'browser',
        run: async () => {
          await seed({ ...page('browser'), 'browser.tabs': { urls: [`http://localhost:${WEB_PORT}/billing`], names: [null], active: 0 } })
          await until(`!!document.querySelector('webview')`)
          await settle(2500)
        }
      },
      {
        name: 'envs',
        run: async () => {
          await writeEnvFixtures(repo, invoices)
          await seed(page('env'))
          await until(`!!document.body.textContent?.includes('STRIPE_SECRET_KEY')`)
          await settle(800)
        }
      },
      {
        name: 'limits',
        run: async () => {
          await writeLimitFixtures(home)
          await seed({
            ...page('terminal'),
            settings: { ...object(baseState().settings), plugins: { ...object(object(baseState().settings).plugins), 'usage-limits': true } },
            'plugin.usage-limits.settings': { usageLabel: 'reset' }
          })
          await until(`!!document.body.textContent?.includes('wk')`)
          await settle(2500)
        }
      },
      {
        name: 'editor',
        run: async () => {
          await seed({ ...baseState(), 'app.place@all': { appTab: 'worktrees', selected: invoices, viewer: { path: 'src/billing/portal.ts', line: 27 } } })
          await until(`!!document.querySelector('.monaco-editor .view-lines')`)
          await settle(1500)
        }
      },
      {
        name: 'hub',
        run: async () => {
          await writeHubFixtures(home, repo)
          await seed({
            ...baseState(),
            settings: { ...object(baseState().settings), plugins: { ...object(object(baseState().settings).plugins), hub: true } },
            'app.place@all': { appTab: 'hub', selected: invoices, viewer: null },
            'hub.selected': 'workflow:ship'
          })
          await until(`!!document.body.textContent?.includes('Ship a ticket')`)
          // React Flow selects on mousedown, so a click() on the card would leave the inspector empty
          const [x, y] = (await evaluate(
            `(() => { const box = document.querySelector('.react-flow__node[data-id="review"]')?.getBoundingClientRect(); return box ? [box.x + box.width / 2, box.y + box.height / 2] : [0, 0] })()`
          )) as [number, number]
          await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          await settle(600)
          await evaluate(`document.querySelector('[title="Fit view"]')?.click()`)
          await settle(1200)
        }
      },
      {
        name: 'agent',
        run: async () => {
          await evaluate(`localStorage.setItem('hub.selected', JSON.stringify('agent:ticket'))`)
          await reload()
          await evaluate(`document.querySelector('[title="Edit agent"]')?.click()`)
          await settle(1000)
        }
      },
      {
        name: 'plugins',
        run: async () => {
          await seed(baseState())
          await evaluate(`document.querySelector('[title^="Settings"]')?.click()`)
          await until(`!!document.body.innerText.includes('Integrations')`)
          await clickText('button', 'Plugins')
          await settle(600)
        }
      },
      {
        name: 'settings',
        run: async () => {
          await seed(baseState())
          await evaluate(`document.querySelector('[title^="Settings"]')?.click()`)
          await until(`!!document.body.innerText.includes('Appearance')`)
          await clickText('button', 'Appearance')
          await settle(600)
        }
      }
    ]

    /** Slide crops for marketing/carousel*.html, so a re-shoot updates the decks too */
    const crops: [string, string, string][] = [
      ['hero', 'crop-hero', '1900x1221+0+0'],
      ['drawer', 'crop-drawer', '1550x995+2450+60']
    ]

    for (const scene of scenes) {
      if (only.length && !only.includes(scene.name)) continue
      if (keepOpen) await scene.run().catch((reason: unknown) => console.log(`  ${String(reason)}`))
      else await scene.run()
      if (!keepOpen) await shot(scene.name)
    }
    if (keepOpen) {
      console.log('app left open; stop this script to close it')
      await new Promise(() => undefined)
    }
    for (const [from, to, geometry] of crops) {
      if (only.length && !only.includes(from)) continue
      const cropped = await Bun.spawn(['magick', join(outDir, `${from}.png`), '-crop', geometry, '+repage', join(outDir, `${to}.png`)]).exited
      if (cropped !== 0) throw new Error(`magick failed on ${from}.png, is ImageMagick installed?`)
      console.log(`  ${to}.png`)
    }
  } finally {
    child.kill()
    devServer?.stop(true)
  }
}

await main()
