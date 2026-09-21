import { expect, test } from 'bun:test'
import type { NetworkEntry } from '../shared/types'
import { applyNetworkEvent, consoleFromApi, consoleFromException, consoleFromLog, keepLast } from './entries'

test('keepLast drops the oldest past the limit', () => {
  expect(keepLast([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
})

test('consoleFromApi joins arguments and keeps the top frame as source', () => {
  const entry = consoleFromApi({
    type: 'error',
    timestamp: 1000,
    args: [{ type: 'string', value: 'Failed' }, { type: 'object', description: 'Error: boom' }],
    stackTrace: { callFrames: [{ functionName: 'render', url: 'http://x/Pricing.tsx', lineNumber: 41, columnNumber: 6 }] }
  })
  expect(entry).toMatchObject({ kind: 'console', level: 'error', text: 'Failed Error: boom', source: 'Pricing.tsx:42', stack: 'at render (http://x/Pricing.tsx:42:7)', time: 1000 })
  expect(consoleFromApi({ nonsense: true })).toBeNull()
})

test('consoleFromException reads the description', () => {
  const entry = consoleFromException({ timestamp: 5, exceptionDetails: { text: 'Uncaught', url: 'http://x/a.js', lineNumber: 0, exception: { description: 'TypeError: y is undefined\n    at a.js:1:1' } } })
  expect(entry).toMatchObject({ level: 'error', text: 'TypeError: y is undefined', stack: 'TypeError: y is undefined\n    at a.js:1:1', source: 'a.js:1' })
})

test('applyNetworkEvent builds a request across its events', () => {
  const requests = new Map<string, NetworkEntry>()
  applyNetworkEvent(requests, 'Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', timestamp: 10, wallTime: 1700000000, request: { url: 'http://x/api', method: 'POST', headers: { a: '1' }, postData: '{}' } })
  applyNetworkEvent(requests, 'Network.responseReceived', { requestId: 'r', response: { status: 500, headers: { b: '2' }, mimeType: 'application/json' } })
  const done = applyNetworkEvent(requests, 'Network.loadingFinished', { requestId: 'r', timestamp: 10.25 })
  expect(done).toMatchObject({ id: 'r', method: 'POST', url: 'http://x/api', resourceType: 'Fetch', status: 500, durationMs: 250, requestHeaders: { a: '1' }, responseHeaders: { b: '2' }, postData: '{}', failed: null })
  const failed = applyNetworkEvent(requests, 'Network.loadingFailed', { requestId: 'r', timestamp: 11, errorText: 'net::ERR_FAILED' })
  expect(failed?.failed).toBe('net::ERR_FAILED')
  expect(applyNetworkEvent(requests, 'Network.loadingFinished', { requestId: 'unknown', timestamp: 1 })).toBeNull()
})

test('an inline script on a root URL names the host, not an empty file', () => {
  const entry = consoleFromApi({ type: 'log', args: [{ type: 'string', value: 'hi' }], stackTrace: { callFrames: [{ url: 'http://localhost:3000/', lineNumber: 3, columnNumber: 0 }] } })
  expect(entry?.source).toBe('localhost:3000:4')
})

test('consoleFromLog maps browser log entries like CSP and mixed content warnings', () => {
  const entry = consoleFromLog({ entry: { source: 'security', level: 'error', text: "Refused to load the script 'http://x/a.js'", timestamp: 7, url: 'http://x/page.html', lineNumber: 9 } })
  expect(entry).toMatchObject({ kind: 'console', level: 'error', text: "Refused to load the script 'http://x/a.js'", source: 'page.html:10', time: 7 })
  expect(consoleFromLog({ entry: { level: 'verbose', text: 'v' } })?.level).toBe('debug')
  expect(consoleFromLog({ nonsense: true })).toBeNull()
})
