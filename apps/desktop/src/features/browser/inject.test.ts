import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The injected page script (src-tauri/src/browser/inject.js) hands its pure helpers to `__treeixTest` when it is defined.
// Ports of the Electron app's browser snapshot and entries tests

interface AxNode {
  nodeId: string
  role: { value: string }
  name: { value: string }
  value?: { value: string }
  childIds: string[]
  backendDOMNodeId: number
  ignored?: boolean
  properties?: { name: string; value: { value: unknown } }[]
}
type Entry = Record<string, unknown>
interface Helpers {
  formatSnapshot(nodes: AxNode[]): string
  parseKey(combo: string): Record<string, unknown> | null
  keepLast<T>(list: T[], item: T, limit?: number): T[]
  sourceOf(stack: string): string
  consoleEntry(level: string, args: unknown[], stack: string, time: number): Entry
  errorEntry(event: { message?: string; filename?: string; lineno?: number; error?: unknown }, time: number): Entry
  cspEntry(event: { blockedURI: string; violatedDirective: string; sourceFile: string; lineNumber: number }, time: number): Entry
  request(method: string, url: string, startedAt: number): Entry & { startedAt: number }
  finished(entry: Entry, status: number | null, failed: string | null, now: number): Entry
}

const scope = globalThis as { __treeixTest?: (helpers: Helpers) => void }
let captured: Helpers | undefined
scope.__treeixTest = (helpers) => void (captured = helpers)
new Function(readFileSync(new URL('../../../src-tauri/src/browser/inject.js', import.meta.url), 'utf8'))()
delete scope.__treeixTest
if (!captured) throw new Error('inject.js did not hand over its helpers')
const h = captured

const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  backendDOMNodeId: Number(nodeId) + 100,
  ...extra,
})

test('formatSnapshot lifts wrappers, drops text repeating its parent and gives refs', () => {
  const nodes = [
    node('1', 'RootWebArea', 'Shop', ['2', '6']),
    node('2', 'generic', '', ['3', '5']),
    node('3', 'link', 'Home', ['4']),
    node('4', 'StaticText', 'Home'),
    node('5', 'textbox', 'Email', [], { value: { value: 'a@b.c' }, properties: [{ name: 'focused', value: { value: true } }] }),
    node('6', 'heading', 'Cart', [], { properties: [{ name: 'level', value: { value: 2 } }] }),
    node('7', 'button', 'Hidden', [], { ignored: true }),
  ]
  expect(h.formatSnapshot(nodes)).toBe(
    ['- RootWebArea "Shop" [ref=101]', '  - link "Home" [ref=103]', '  - textbox "Email" value="a@b.c" focused [ref=105]', '  - heading "Cart" level=2 [ref=106]'].join('\n')
  )
})

test('parseKey knows named keys, characters and modifiers', () => {
  expect(h.parseKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
  expect(h.parseKey('Meta+a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: undefined, modifiers: 4 })
  expect(h.parseKey('Shift+Tab')).toMatchObject({ code: 'Tab', modifiers: 8 })
  expect(h.parseKey('Hyper+x')).toBeNull()
  expect(h.parseKey('F13')).toBeNull()
})

test('keepLast drops the oldest past the limit', () => {
  expect(h.keepLast([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
})

test('consoleEntry joins arguments and keeps the top frame as source', () => {
  const entry = h.consoleEntry('error', ['Failed', new TypeError('boom'), { a: 1 }], 'render@http://x/Pricing.tsx:42:7\n@http://x/main.tsx:1:1', 1000)
  expect(entry).toMatchObject({ kind: 'console', level: 'error', text: 'Failed TypeError: boom {"a":1}', source: 'Pricing.tsx:42', time: 1000 })
  expect(h.sourceOf('    at render (http://x/a.js:3:9)')).toBe('a.js:3')
  expect(h.sourceOf('no frames')).toBe('')
})

test('errorEntry reads the first line of the error', () => {
  const entry = h.errorEntry({ message: 'Uncaught', filename: 'http://x/a.js', lineno: 1, error: new TypeError('y is undefined\n    at a.js:1:1') }, 5)
  expect(entry).toMatchObject({ level: 'error', text: 'TypeError: y is undefined', source: 'a.js:1', time: 5 })
})

test('an inline script on a root URL names the host, not an empty file', () => {
  expect(h.consoleEntry('log', ['hi'], '@http://localhost:3000/:4:1', 0).source).toBe('localhost:3000:4')
})

test('cspEntry maps a CSP violation to an error row', () => {
  const entry = h.cspEntry({ blockedURI: 'http://x/a.js', violatedDirective: 'script-src', sourceFile: 'http://x/page.html', lineNumber: 10 }, 7)
  expect(entry).toMatchObject({ kind: 'console', level: 'error', source: 'page.html:10', time: 7 })
  expect(String(entry.text)).toStartWith('Refused to load http://x/a.js')
})

test('request and finished build a network row', () => {
  const started = h.request('post', 'http://x/api', 10)
  expect(started).toMatchObject({ kind: 'network', method: 'POST', url: 'http://x/api', status: null, failed: null, durationMs: null })
  expect(h.finished(started, 500, null, 260)).toMatchObject({ status: 500, durationMs: 250, failed: null })
  expect(h.finished(started, null, 'Failed to fetch', 11)).toMatchObject({ failed: 'Failed to fetch', durationMs: 1 })
})
