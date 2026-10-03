import { BrowserWindow, type WebContents } from 'electron'
import type { MainContext, McpContent, McpTool } from '@treeix/sdk/main'
import { guestLog, responseBody } from './guests'
import { type AxNode, formatSnapshot, parseKey } from './snapshot'

const OPEN_TIMEOUT_MS = 20_000
const LOAD_TIMEOUT_MS = 15_000
const WAIT_LIMIT_MS = 60_000
const SHOW_DELAY_MS = 300
const SCREENSHOT_WIDTH = 1280
const VALUE_LIMIT = 20_000

/** Pages by the renderer's tab id, as each reports itself ready */
const tabs = new Map<string, WebContents>()
const opening = new Map<string, (guest: WebContents) => void>()

export function registerTab(tabId: string, guest: WebContents): void {
  tabs.set(tabId, guest)
  guest.once('destroyed', () => tabs.get(tabId) === guest && tabs.delete(tabId))
  opening.get(tabId)?.(guest)
  opening.delete(tabId)
}

const string = (args: Record<string, unknown>, name: string): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}
const optionalNumber = (args: Record<string, unknown>, name: string, fallback: number): number =>
  typeof args[name] === 'number' && Number.isFinite(args[name]) ? args[name] : fallback

function pageOf(args: Record<string, unknown>): WebContents {
  const id = string(args, 'tab')
  const guest = tabs.get(id)
  if (!guest || guest.isDestroyed()) throw new Error(`No tab ${id}; browser_tabs lists the open ones`)
  return guest
}

/** Only web pages: Chromium keeps pages off file: and other local schemes, and so must agents */
function webUrl(value: string): string {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `http://${value}`
  if (!/^https?:\/\//i.test(url) && url !== 'about:blank') throw new Error('Only http and https addresses open here')
  return url
}

const describe = (guest: WebContents): string => `${guest.getTitle() || '(untitled)'} | ${guest.getURL()}`

function settled(guest: WebContents): Promise<void> {
  if (!guest.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, LOAD_TIMEOUT_MS)
    guest.once('did-stop-loading', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function cdp<T>(guest: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
  if (!guest.debugger.isAttached()) throw new Error('DevTools is open on this page and holds it; close DevTools and try again')
  return (await guest.debugger.sendCommand(method, params)) as T
}

// ponytail: the focused window, else any; one per session's own window if people run agents across several windows
const targetWindow = (): BrowserWindow | null =>
  BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((window) => window.isVisible()) ?? BrowserWindow.getAllWindows()[0] ?? null

const tabIdOf = (guest: WebContents): string | undefined => [...tabs].find(([, candidate]) => candidate === guest)?.[0]

function show(context: MainContext, guest: WebContents): void {
  const id = tabIdOf(guest)
  if (id && guest.hostWebContents) context.send(guest.hostWebContents, 'show', id)
}

/** Where a ref sits on screen, scrolled into view first */
async function centerOf(guest: WebContents, ref: number): Promise<{ x: number; y: number }> {
  try {
    await cdp(guest, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref })
    const { model } = await cdp<{ model: { content: number[] } }>(guest, 'DOM.getBoxModel', { backendNodeId: ref })
    const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content
    return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 }
  } catch {
    throw new Error(`Ref ${ref} is gone or not visible; take a new browser_snapshot`)
  }
}

function refOf(args: Record<string, unknown>): number {
  const ref = Number(args.ref)
  if (!Number.isInteger(ref)) throw new Error('ref is required: a number from browser_snapshot')
  return ref
}

/**
 * The key inside the page, for when a real one can't land: an unfocused page drops keyboard input. Its events are
 * untrusted, so the defaults agents lean on are done by hand: typing, deleting, and Enter submitting or clicking.
 */
const SYNTHETIC_KEY = `function (key, code, text, modifiers) {
  const target = document.activeElement ?? document.body
  const init = { key, code, bubbles: true, cancelable: true, composed: true, altKey: !!(modifiers & 1), ctrlKey: !!(modifiers & 2), metaKey: !!(modifiers & 4), shiftKey: !!(modifiers & 8) }
  if (target.dispatchEvent(new KeyboardEvent('keydown', init))) {
    if (text && text !== '\\r') document.execCommand('insertText', false, text)
    else if (key === 'Backspace') document.execCommand('delete')
    else if (key === 'Delete') document.execCommand('forwardDelete')
    else if (key === 'Enter' && target instanceof HTMLInputElement && target.form) target.form.requestSubmit()
    else if (key === 'Enter' && (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)) target.click()
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init))
}`

/** A real key press when the page takes it, else the same key fired inside the page */
async function press(guest: WebContents, combo: string): Promise<void> {
  const key = parseKey(combo)
  if (!key) throw new Error(`Unknown key ${combo}; use names like Enter, Tab, Escape, ArrowDown, a, or Meta+a`)
  const flag = '__treeixKeyLanded'
  await cdp(guest, 'Runtime.evaluate', { expression: `window.${flag} = false; addEventListener('keydown', () => { window.${flag} = true }, { once: true, capture: true })` })
  const common = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: key.modifiers }
  await cdp(guest, 'Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', text: key.text, ...common })
  await cdp(guest, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  const { result } = await cdp<{ result: { value?: unknown } }>(guest, 'Runtime.evaluate', { expression: `window.${flag}`, returnByValue: true })
  if (result.value === true) return
  const { result: page } = await cdp<{ result: { objectId?: string } }>(guest, 'Runtime.evaluate', { expression: 'document' })
  await cdp(guest, 'Runtime.callFunctionOn', {
    objectId: page.objectId,
    functionDeclaration: SYNTHETIC_KEY,
    arguments: [{ value: key.key }, { value: key.code }, { value: key.text ?? '' }, { value: key.modifiers }]
  })
}

const clip = (text: string): string => (text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}\n(cut at ${VALUE_LIMIT / 1000}k characters)` : text)

/**
 * Picks an option of a select, or replaces a field's text the way typing would, with input events React listens to.
 * In the page, since CDP's typing needs the page to hold focus, which would take it from the user.
 */
const FILL_FIELD = `function (value) {
  const changed = () => {
    this.dispatchEvent(new Event('input', { bubbles: true }))
    this.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (this instanceof HTMLSelectElement) {
    const option = [...this.options].find((candidate) => candidate.value === value || candidate.label === value || candidate.text.trim() === value)
    if (!option) return 'no-option'
    this.value = option.value
    changed()
    return 'done'
  }
  this.focus()
  if (typeof this.select === 'function') this.select()
  else {
    const range = document.createRange()
    range.selectNodeContents(this)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  }
  if (document.execCommand('insertText', false, value) && (this.value ?? this.textContent) === value) return 'done'
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value')?.set
  if (!setter) return 'not-a-field'
  setter.call(this, value)
  changed()
  return 'done'
}`

const TAB = { tab: { type: 'string', description: 'Tab id from browser_navigate or browser_tabs' } }
const REF = { ref: { type: 'number', description: 'Element ref from browser_snapshot' } }
const schema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })

export function browserTools(context: MainContext): McpTool[] {
  return [
    {
      name: 'browser_tabs',
      description: "Lists the tabs open in Treeix's built-in browser: id, title and address.",
      inputSchema: schema({}, []),
      run: async () =>
        [...tabs]
          .filter(([, guest]) => !guest.isDestroyed())
          .map(([id, guest]) => `${id}  ${describe(guest)}`)
          .join('\n') || 'No tabs are open'
    },
    {
      name: 'browser_navigate',
      description:
        "Loads an address in a tab, or in a new tab of Treeix's built-in browser when no tab is given, and waits for the page. Returns the tab id the other browser tools take.",
      inputSchema: schema(
        {
          ...TAB,
          url: { type: 'string', description: 'http or https; a bare host like localhost:3000 gets http://' },
          action: { type: 'string', enum: ['back', 'forward', 'reload'] }
        },
        []
      ),
      run: async (args) => {
        if (args.tab === undefined) {
          const url = webUrl(string(args, 'url'))
          const window = targetWindow()
          if (!window) throw new Error('Treeix has no window open')
          const id = crypto.randomUUID()
          const guest = await new Promise<WebContents>((resolve, reject) => {
            const timer = setTimeout(() => {
              opening.delete(id)
              reject(new Error('The browser did not open the tab; is the Browser plugin on?'))
            }, OPEN_TIMEOUT_MS)
            opening.set(id, (ready) => {
              clearTimeout(timer)
              resolve(ready)
            })
            context.send(window.webContents, 'open', url, id)
          })
          await settled(guest)
          return `Opened tab ${id}: ${describe(guest)}`
        }
        const guest = pageOf(args)
        show(context, guest)
        if (args.action === 'back') guest.navigationHistory.goBack()
        else if (args.action === 'forward') guest.navigationHistory.goForward()
        else if (args.action === 'reload') guest.reload()
        // A failed load still leaves the page telling what went wrong
        else await guest.loadURL(webUrl(string(args, 'url'))).catch(() => undefined)
        await pause(100)
        await settled(guest)
        return describe(guest)
      }
    },
    {
      name: 'browser_snapshot',
      description:
        "The page's accessibility tree as text: roles, names, values and states, with refs for browser_click and browser_type. Cheaper and more exact than a screenshot.",
      inputSchema: schema(TAB, ['tab']),
      run: async (args) => {
        const guest = pageOf(args)
        const { nodes } = await cdp<{ nodes: AxNode[] }>(guest, 'Accessibility.getFullAXTree')
        return `${describe(guest)}\n\n${formatSnapshot(nodes)}`
      }
    },
    {
      name: 'browser_click',
      description: 'Clicks an element by its ref from browser_snapshot, with a real mouse click.',
      inputSchema: schema({ ...TAB, ...REF, double: { type: 'boolean', description: 'Double click' } }, ['tab', 'ref']),
      run: async (args) => {
        const guest = pageOf(args)
        const { x, y } = await centerOf(guest, refOf(args))
        const clickCount = args.double === true ? 2 : 1
        await cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        for (let count = 1; count <= clickCount; count++) {
          await cdp(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count })
          await cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
        }
        await pause(150)
        await settled(guest)
        return `Clicked. ${describe(guest)}`
      }
    },
    {
      name: 'browser_type',
      description: 'Replaces the text of a field by its ref, or picks an option of a select by its value or label. submit presses Enter after.',
      inputSchema: schema({ ...TAB, ...REF, text: { type: 'string' }, submit: { type: 'boolean' } }, ['tab', 'ref', 'text']),
      run: async (args) => {
        const guest = pageOf(args)
        const text = typeof args.text === 'string' ? args.text : ''
        const ref = refOf(args)
        const { object } = await cdp<{ object: { objectId?: string } }>(guest, 'DOM.resolveNode', { backendNodeId: ref }).catch(() => {
          throw new Error(`Ref ${ref} is gone; take a new browser_snapshot`)
        })
        const { result } = await cdp<{ result: { value?: unknown } }>(guest, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: FILL_FIELD,
          arguments: [{ value: text }],
          returnByValue: true
        })
        if (result.value === 'no-option') throw new Error(`The select has no option ${text}`)
        if (result.value === 'not-a-field') throw new Error(`Ref ${ref} is not a field one can type in`)
        if (args.submit === true) await press(guest, 'Enter')
        await pause(100)
        await settled(guest)
        return `Typed. ${describe(guest)}`
      }
    },
    {
      name: 'browser_press',
      description: 'Presses a key in the focused element: Enter, Tab, Escape, Backspace, ArrowDown, a single character, or a combination like Meta+a or Shift+Tab.',
      inputSchema: schema({ ...TAB, key: { type: 'string' } }, ['tab', 'key']),
      run: async (args) => {
        const guest = pageOf(args)
        await press(guest, string(args, 'key'))
        await pause(100)
        await settled(guest)
        return `Pressed. ${describe(guest)}`
      }
    },
    {
      name: 'browser_evaluate',
      description: 'Runs a JavaScript expression in the page and returns its value as JSON; promises are awaited.',
      inputSchema: schema({ ...TAB, expression: { type: 'string' } }, ['tab', 'expression']),
      run: async (args) => {
        const guest = pageOf(args)
        const { result, exceptionDetails } = await cdp<{
          result: { value?: unknown; type: string; description?: string }
          exceptionDetails?: { exception?: { description?: string }; text?: string }
        }>(guest, 'Runtime.evaluate', {
          expression: string(args, 'expression'),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true
        })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'The expression threw')
        return clip(result.type === 'undefined' ? 'undefined' : (JSON.stringify(result.value, null, 2) ?? result.description ?? result.type))
      }
    },
    {
      name: 'browser_screenshot',
      description: 'Shows the tab to the user and returns a screenshot of what is visible in it.',
      inputSchema: schema(TAB, ['tab']),
      run: async (args): Promise<McpContent[]> => {
        const guest = pageOf(args)
        show(context, guest)
        await pause(SHOW_DELAY_MS)
        let image = await guest.capturePage()
        if (image.isEmpty()) throw new Error('The tab is not on screen, so there is nothing to capture')
        if (image.getSize().width > SCREENSHOT_WIDTH) image = image.resize({ width: SCREENSHOT_WIDTH })
        return [{ type: 'image', data: image.toPNG().toString('base64'), mimeType: 'image/png' }]
      }
    },
    {
      name: 'browser_console',
      description: 'Console messages and uncaught errors of the page since it last changed site, newest last.',
      inputSchema: schema({ ...TAB, limit: { type: 'number', description: 'How many of the newest to return, 50 by default' } }, ['tab']),
      run: async (args) => {
        const entries = guestLog(pageOf(args)).console.slice(-optionalNumber(args, 'limit', 50))
        return clip(
          entries.map((entry) => `[${entry.level}] ${entry.text}${entry.source ? ` (${entry.source})` : ''}${entry.stack ? `\n${entry.stack}` : ''}`).join('\n') || 'Nothing logged'
        )
      }
    },
    {
      name: 'browser_network',
      description: 'Requests the page made since it last changed site, newest last; with an id, that request with its headers and response body.',
      inputSchema: schema(
        {
          ...TAB,
          filter: { type: 'string', description: 'Only addresses containing this' },
          id: { type: 'string', description: 'Request id from the list' },
          limit: { type: 'number' }
        },
        ['tab']
      ),
      run: async (args) => {
        const guest = pageOf(args)
        const requests = guestLog(guest).network
        if (typeof args.id === 'string') {
          const request = requests.find((candidate) => candidate.id === args.id)
          if (!request) throw new Error(`No request ${args.id}`)
          const headers = (list: Record<string, string>): string =>
            Object.entries(list)
              .map(([name, value]) => `  ${name}: ${value}`)
              .join('\n')
          const body = await responseBody(guest, request.id)
          return clip(
            [
              `${request.method} ${request.url}`,
              `Status: ${request.status ?? request.failed ?? 'pending'}`,
              `Request headers:\n${headers(request.requestHeaders)}`,
              request.postData && `Request body:\n${request.postData}`,
              `Response headers:\n${headers(request.responseHeaders)}`,
              `Response body:\n${body ?? '(not available)'}`
            ]
              .filter(Boolean)
              .join('\n\n')
          )
        }
        const filter = typeof args.filter === 'string' ? args.filter : ''
        const shown = requests.filter((request) => request.url.includes(filter)).slice(-optionalNumber(args, 'limit', 50))
        return clip(
          shown
            .map(
              (request) =>
                `${request.id} ${request.method} ${request.status ?? request.failed ?? 'pending'} ${request.url} (${request.resourceType}${request.durationMs === null ? '' : `, ${Math.round(request.durationMs)} ms`})`
            )
            .join('\n') || 'No requests'
        )
      }
    },
    {
      name: 'browser_wait_for',
      description: 'Waits until the text shows on the page, 10 seconds by default.',
      inputSchema: schema({ ...TAB, text: { type: 'string' }, timeoutMs: { type: 'number' } }, ['tab', 'text']),
      run: async (args) => {
        const guest = pageOf(args)
        const text = string(args, 'text')
        const deadline = Date.now() + Math.min(optionalNumber(args, 'timeoutMs', 10_000), WAIT_LIMIT_MS)
        while (Date.now() < deadline) {
          const { result } = await cdp<{ result: { value?: unknown } }>(guest, 'Runtime.evaluate', {
            expression: `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`,
            returnByValue: true
          }).catch(() => ({ result: { value: false } }))
          if (result.value === true) return `Found. ${describe(guest)}`
          await pause(250)
        }
        throw new Error(`${text} did not show up in time`)
      }
    },
    {
      name: 'browser_close',
      description: 'Closes a tab.',
      inputSchema: schema(TAB, ['tab']),
      run: async (args) => {
        const guest = pageOf(args)
        const id = string(args, 'tab')
        if (guest.hostWebContents) context.send(guest.hostWebContents, 'close', id)
        return `Closed ${id}`
      }
    }
  ]
}
