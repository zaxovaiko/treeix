// Treeix browser pane: injected into every page of a browser pane (crate::browser). It keeps the page's console
// and network entries for the pane to `drain`, and serves the agent tools (snapshot, click, type, press) by eval.
// Everything it reads comes from the page, so the Rust side parses its answers defensively.
// Port of packages/plugins/browser/main/{snapshot,entries}.ts; tests in apps/next/src/features/browser/inject.test.ts
;(() => {
  const ENTRY_LIMIT = 500
  const TEXT_LIMIT = 4000
  const SNAPSHOT_LIMIT = 60_000

  /** Wrappers that say nothing on their own; their children take their place */
  const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'group', 'Section', 'paragraph', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])
  const STATES = new Set(['focused', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid'])
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem'])

  const str = (value) =>
    typeof value?.value === 'string' || typeof value?.value === 'number' || typeof value?.value === 'boolean' ? String(value.value) : ''
  const quoted = (value) => JSON.stringify(value.replace(/\s+/g, ' ').trim().slice(0, 200))

  /**
   * The page as an indented outline, one line per meaningful node. Nodes are accessibility-tree shaped
   * ({ nodeId, role, name, value, childIds, backendDOMNodeId, properties }); refs are what click and type take.
   */
  function formatSnapshot(nodes) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]))
    const lines = []
    let size = 0
    const walk = (node, depth, parentName) => {
      if (size > SNAPSHOT_LIMIT) return
      const role = str(node.role)
      const name = str(node.name).trim()
      const text = role === 'StaticText'
      // A link or button already carries its text as its name
      const repeats = text && name === parentName
      const shown = !node.ignored && !repeats && (text ? name !== '' : !TRANSPARENT.has(role) || name !== '') && role !== ''
      if (shown) {
        const states = (node.properties ?? []).filter((property) => STATES.has(property.name) && property.value.value === true).map((property) => property.name)
        const level = (node.properties ?? []).find((property) => property.name === 'level')
        const value = str(node.value)
        const parts = [
          text ? 'text' : role,
          name && quoted(name),
          level && `level=${str(level.value)}`,
          value && value !== name && `value=${quoted(value)}`,
          ...states,
          node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || !text) && `[ref=${node.backendDOMNodeId}]`,
        ].filter(Boolean)
        const line = `${'  '.repeat(depth)}- ${parts.join(' ')}`
        lines.push(line)
        size += line.length + 1
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId)
        if (child) walk(child, shown ? depth + 1 : depth, name || parentName)
      }
    }
    const root = nodes[0]
    if (root) walk(root, 0, '')
    return size > SNAPSHOT_LIMIT ? `${lines.join('\n')}\n(cut at ${SNAPSHOT_LIMIT / 1000}k characters)` : lines.join('\n')
  }

  /** Key names agents use */
  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
  }
  const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

  /** "Enter", "Meta+a", "Shift+Tab"; null for a name it doesn't know */
  function parseKey(combo) {
    const parts = combo.split('+').filter(Boolean)
    const name = parts.pop() ?? ''
    if (parts.some((part) => !(part in MODIFIERS))) return null
    const modifiers = parts.reduce((mask, part) => mask | MODIFIERS[part], 0)
    const known = KEYS[name === ' ' ? 'Space' : name]
    if (known) return { key: name === 'Space' ? ' ' : name, ...known, text: modifiers & ~MODIFIERS.Shift ? undefined : known.text, modifiers }
    if (name.length !== 1) return null
    const upper = name.toUpperCase()
    const letter = /[A-Z]/.test(upper)
    const digit = /[0-9]/.test(name)
    return {
      key: name,
      code: letter ? `Key${upper}` : digit ? `Digit${name}` : '',
      keyCode: letter || digit ? upper.charCodeAt(0) : 0,
      // With Meta or Control it's a shortcut, not typing
      text: modifiers & (MODIFIERS.Meta | MODIFIERS.Control) ? undefined : name,
      modifiers,
    }
  }

  const keepLast = (list, item, limit = ENTRY_LIMIT) => [...list, item].slice(-limit)
  const clip = (text) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text)

  // A root URL like http://host/ has no file name, so its host stands in
  const fileOf = (url) => {
    const parts = url.split(/[?#]/)[0].split('/')
    return parts.at(-1) || parts[2] || url
  }

  /** `file:line` of the first frame with an address, in WebKit's `fn@url:line:col` or V8's `at fn (url:line:col)` */
  function sourceOf(stack) {
    for (const line of String(stack ?? '').split('\n')) {
      const frame = line.match(/([a-z][\w+.-]*:\/\/[^\s()]+):(\d+):\d+/i)
      if (frame) return `${fileOf(frame[1])}:${frame[2]}`
    }
    return ''
  }

  const describe = (value) => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return String(value)
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }

  let counter = 0
  const nextId = () => `e${++counter}`

  /** A console call; `stack` is where it was made */
  const consoleEntry = (level, args, stack, time) => ({ kind: 'console', id: nextId(), level, text: clip(args.map(describe).join(' ')), source: sourceOf(stack), time })

  /** An uncaught error, from the window's ErrorEvent fields */
  function errorEntry({ message, filename, lineno, error }, time) {
    const description = error instanceof Error ? `${error.name}: ${error.message}` : String(message ?? 'Error')
    return { kind: 'console', id: nextId(), level: 'error', text: clip(description.split('\n')[0]), source: filename ? `${fileOf(filename)}:${lineno ?? 0}` : sourceOf(error?.stack), time }
  }

  /** WebKit's own refusals, like CSP violations, which never reach console.* */
  const cspEntry = ({ blockedURI, violatedDirective, sourceFile, lineNumber }, time) => ({
    kind: 'console',
    id: nextId(),
    level: 'error',
    text: `Refused to load ${blockedURI || 'a resource'} because it violates the Content Security Policy directive: ${violatedDirective}`,
    source: sourceFile ? `${fileOf(sourceFile)}:${lineNumber ?? 0}` : '',
    time,
  })

  const request = (method, url, startedAt) => ({ kind: 'network', id: nextId(), method: String(method || 'GET').toUpperCase(), url, status: null, failed: null, startedAt, durationMs: null })
  /** The request with its outcome: a status, or why it failed */
  const finished = (entry, status, failed, now) => ({ ...entry, status, failed, durationMs: Math.max(0, now - entry.startedAt) })

  const helpers = { formatSnapshot, parseKey, keepLast, sourceOf, consoleEntry, errorEntry, cspEntry, request, finished }
  if (typeof globalThis.__treeixTest === 'function') globalThis.__treeixTest(helpers)
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.__treeix) return

  /* ---------- capture ---------- */

  let pending = []
  let reset = true
  const queue = (entry) => {
    // A request that changed replaces its earlier row in the batch
    pending = keepLast(
      pending.filter((queued) => queued.id !== entry.id),
      entry
    )
  }

  const LEVELS = { log: 'log', info: 'info', warn: 'warning', error: 'error', debug: 'debug' }
  for (const [method, level] of Object.entries(LEVELS)) {
    const native = console[method]
    console[method] = function (...args) {
      queue(consoleEntry(level, args, new Error().stack?.split('\n').slice(1).join('\n'), Date.now()))
      return native.apply(this, args)
    }
  }
  addEventListener('error', (event) => event instanceof ErrorEvent && queue(errorEntry(event, Date.now())))
  addEventListener('unhandledrejection', (event) => queue({ ...consoleEntry('error', ['Uncaught (in promise)', event.reason], event.reason?.stack, Date.now()) }))
  addEventListener('securitypolicyviolation', (event) => queue(cspEntry(event, Date.now())))

  const absolute = (url) => {
    try {
      return new URL(url, location.href).href
    } catch {
      return String(url)
    }
  }
  const nativeFetch = window.fetch
  window.fetch = function (input, init) {
    const source = input instanceof Request ? input : null
    let entry = request(init?.method ?? source?.method, absolute(source ? source.url : input), Date.now())
    queue(entry)
    return nativeFetch.apply(this, arguments).then(
      (response) => {
        queue((entry = finished(entry, response.status, null, Date.now())))
        return response
      },
      (error) => {
        queue((entry = finished(entry, null, error?.message ? String(error.message) : 'failed', Date.now())))
        throw error
      }
    )
  }
  const xhr = new WeakMap()
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    xhr.set(this, { method, url: absolute(url) })
    return open.apply(this, arguments)
  }
  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function () {
    const target = xhr.get(this)
    if (target) {
      const entry = request(target.method, target.url, Date.now())
      queue(entry)
      this.addEventListener('loadend', () => queue(finished(entry, this.status || null, this.status ? null : 'failed', Date.now())))
    }
    return send.apply(this, arguments)
  }
  // The document and what it loads by itself (scripts, styles, images); fetch and XHR are counted above
  const timing = (entry) => {
    if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') return
    const startedAt = Math.round(performance.timeOrigin + entry.startTime)
    const status = typeof entry.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null
    queue({ ...request('GET', entry.name, startedAt), status, durationMs: Math.round(entry.duration) })
  }
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(timing)).observe({ type: 'resource', buffered: true })
    new PerformanceObserver((list) => list.getEntries().forEach(timing)).observe({ type: 'navigation', buffered: true })
  } catch {
    // An engine without these entry types still reports fetch and XHR
  }

  /* ---------- agent tools ---------- */

  const refs = new Map()
  const refOf = new WeakMap()
  const ref = (element) => {
    let id = refOf.get(element)
    if (id === undefined) {
      id = refs.size + 1
      refOf.set(element, id)
      refs.set(id, new WeakRef(element))
    }
    return id
  }
  const target = (id) => {
    const element = refs.get(Number(id))?.deref()
    return element?.isConnected ? element : null
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
  const HEADING = /^H([1-6])$/
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', submit: 'button', button: 'button', reset: 'button', image: 'button' }
  const TAG_ROLES = {
    BUTTON: 'button', SUMMARY: 'button', TEXTAREA: 'textbox', OPTION: 'option', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', DIALOG: 'dialog',
    P: 'paragraph', PROGRESS: 'progressbar', HR: 'separator', ARTICLE: 'article', FIELDSET: 'group', DETAILS: 'group', IFRAME: 'Iframe',
  }
  /** Roles whose name is their text */
  const FROM_CONTENT = new Set(['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'cell', 'columnheader', 'checkbox', 'radio', 'switch', 'treeitem'])

  function roleOf(element) {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit) return explicit
    const tag = element.tagName
    if (tag === 'A') return element.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'INPUT') return INPUT_ROLES[element.type] ?? (element.hasAttribute('list') ? 'combobox' : 'textbox')
    if (tag === 'SELECT') return element.multiple || element.size > 1 ? 'listbox' : 'combobox'
    if (tag === 'IMG') return element.getAttribute('alt') === '' ? 'presentation' : 'img'
    if (HEADING.test(tag)) return 'heading'
    return TAG_ROLES[tag] ?? 'generic'
  }

  const textOf = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()

  function nameOf(element, role) {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ')
      if (label) return label
    }
    const label = element.getAttribute('aria-label')
    if (label?.trim()) return label.trim()
    if (element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(element.type)) return element.value || (element.type === 'submit' ? 'Submit' : '')
    if (element.labels?.length) return [...element.labels].map(textOf).join(' ')
    if (element.tagName === 'IMG') return element.getAttribute('alt') ?? element.getAttribute('title') ?? ''
    if (FROM_CONTENT.has(role)) return textOf(element)
    return element.getAttribute('placeholder') ?? element.getAttribute('title') ?? ''
  }

  const hidden = (element) =>
    element.hidden || element.getAttribute('aria-hidden') === 'true' || (typeof element.checkVisibility === 'function' && !element.checkVisibility({ visibilityProperty: true }))

  /** The DOM as accessibility-tree nodes, for formatSnapshot */
  function axNodes() {
    const nodes = []
    const add = (node) => (nodes.push(node), node.nodeId)
    const children = (parent) => {
      const ids = []
      for (const child of [...(parent.shadowRoot?.childNodes ?? []), ...parent.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent.replace(/\s+/g, ' ').trim()
          if (text) ids.push(add({ nodeId: String(nodes.length), role: { value: 'StaticText' }, name: { value: text } }))
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP.has(child.tagName) && !hidden(child)) ids.push(element(child))
      }
      return ids
    }
    const element = (node) => {
      const role = roleOf(node)
      const nodeId = String(nodes.length)
      const entry = { nodeId, role: { value: role }, name: { value: nameOf(node, role) }, backendDOMNodeId: ref(node), properties: [] }
      nodes.push(entry)
      const flag = (name, on) => on && entry.properties.push({ name, value: { value: true } })
      flag('focused', document.activeElement === node)
      flag('checked', node.checked === true || node.getAttribute('aria-checked') === 'true')
      flag('pressed', node.getAttribute('aria-pressed') === 'true')
      flag('selected', (node.tagName === 'OPTION' && node.selected) || node.getAttribute('aria-selected') === 'true')
      flag('expanded', node.getAttribute('aria-expanded') === 'true' || (node.tagName === 'DETAILS' && node.open))
      flag('disabled', node.disabled === true || node.getAttribute('aria-disabled') === 'true')
      flag('required', node.required === true || node.getAttribute('aria-required') === 'true')
      flag('invalid', node.getAttribute('aria-invalid') === 'true')
      const heading = node.tagName.match(HEADING)
      if (heading || role === 'heading') entry.properties.push({ name: 'level', value: { value: Number(heading?.[1] ?? node.getAttribute('aria-level') ?? 2) } })
      if ('value' in node && typeof node.value === 'string' && !['button', 'option', 'checkbox', 'radio'].includes(role)) entry.value = { value: node.type === 'password' ? '•'.repeat(node.value.length) : node.value }
      // A select's options and a field's text are its value, not more nodes
      entry.childIds = node.tagName === 'SELECT' || node.tagName === 'TEXTAREA' || role === 'Iframe' ? [] : children(node)
      return nodeId
    }
    nodes.push({ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: document.title }, childIds: [] })
    nodes[0].childIds = document.body ? children(document.body) : []
    return nodes
  }

  const describePage = () => `${document.title || '(untitled)'} | ${location.href}`

  /** Clicks as untrusted events plus the element's own default; a page out of sight has no layout for a real mouse */
  function click(id, double) {
    const element = target(id)
    if (!element) return 'gone'
    element.scrollIntoView({ block: 'center', inline: 'center' })
    if (typeof element.focus === 'function') element.focus({ preventScroll: true })
    const init = { bubbles: true, cancelable: true, composed: true, view: window }
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      element.dispatchEvent(new PointerEvent('pointerdown', { ...init, detail: count }))
      element.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: count }))
      element.dispatchEvent(new PointerEvent('pointerup', { ...init, detail: count }))
      element.dispatchEvent(new MouseEvent('mouseup', { ...init, detail: count }))
      element.click()
    }
    if (double) element.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }))
    return 'done'
  }

  /** Picks an option of a select, or replaces a field's text the way typing would, with input events React listens to */
  function fill(id, value) {
    const element = target(id)
    if (!element) return 'gone'
    const changed = () => {
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (element instanceof HTMLSelectElement) {
      const option = [...element.options].find((candidate) => candidate.value === value || candidate.label === value || candidate.text.trim() === value)
      if (!option) return 'no-option'
      element.value = option.value
      changed()
      return 'done'
    }
    element.focus()
    if (typeof element.select === 'function') element.select()
    else {
      const range = document.createRange()
      range.selectNodeContents(element)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    }
    if (document.execCommand('insertText', false, value) && (element.value ?? element.textContent) === value) return 'done'
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
    if (!setter) return 'not-a-field'
    setter.call(element, value)
    changed()
    return 'done'
  }

  /** The key in the focused element; its events are untrusted, so typing, deleting and Enter are done by hand */
  function press(combo) {
    const key = parseKey(String(combo))
    if (!key) return 'unknown'
    const focused = document.activeElement ?? document.body
    const modifiers = key.modifiers
    const init = { key: key.key, code: key.code, keyCode: key.keyCode, bubbles: true, cancelable: true, composed: true, altKey: !!(modifiers & 1), ctrlKey: !!(modifiers & 2), metaKey: !!(modifiers & 4), shiftKey: !!(modifiers & 8) }
    if (focused.dispatchEvent(new KeyboardEvent('keydown', init))) {
      if (key.text && key.text !== '\r') document.execCommand('insertText', false, key.text)
      else if (key.key === 'Backspace') document.execCommand('delete')
      else if (key.key === 'Delete') document.execCommand('forwardDelete')
      else if (key.key === 'Enter' && focused instanceof HTMLInputElement && focused.form) focused.form.requestSubmit()
      else if (key.key === 'Enter' && (focused instanceof HTMLButtonElement || focused instanceof HTMLAnchorElement)) focused.click()
    }
    focused.dispatchEvent(new KeyboardEvent('keyup', init))
    return 'done'
  }

  const api = {
    /** What happened since the last call; `reset` on the first call of a document */
    drain() {
      const batch = {
        reset,
        entries: pending,
        canGoBack: window.navigation ? navigation.canGoBack : history.length > 1,
        canGoForward: window.navigation?.canGoForward ?? false,
      }
      pending = []
      reset = false
      return batch
    },
    snapshot: () => `${describePage()}\n\n${formatSnapshot(axNodes())}`,
    click,
    fill,
    press,
    describe: describePage,
  }
  Object.defineProperty(window, '__treeix', { value: Object.freeze(api) })
})()
