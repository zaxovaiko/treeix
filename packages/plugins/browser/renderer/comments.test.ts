import { expect, test } from 'bun:test'
import type { ConsoleEntry, ElementSelection, NetworkEntry, Vital } from '../shared/types'
import { consoleComment, elementComment, entryCommentId, networkComment, vitalComment } from './comments'

const page = 'http://localhost:3000/pricing'

test('elementComment carries the selector, text and HTML excerpt', () => {
  const selection: ElementSelection = { selector: '.plan:nth-of-type(2) .price', tag: 'span', text: '$NaN', html: '<span class="price">$NaN</span>', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 }, url: page }
  const comment = elementComment(selection, 'Shows NaN', '/repo', { path: '/att/a.png', name: 'a.png' })
  expect(comment).toMatchObject({ kind: 'browser', filePath: page, text: 'Shows NaN', worktreePath: '/repo', range: { start: 0, end: 0 }, code: '', attachments: [{ path: '/att/a.png', name: 'a.png' }] })
  expect(comment.body).toBe('Element: .plan:nth-of-type(2) .price\nText: $NaN\nHTML: <span class="price">$NaN</span>')
})

test('consoleComment and networkComment summarise and keep details in the body', () => {
  const log: ConsoleEntry = { kind: 'console', id: 'c1', level: 'error', text: "TypeError: x is undefined", source: 'Pricing.tsx:42', stack: 'at render (Pricing.tsx:42:7)', time: 0 }
  expect(consoleComment(log, 7, page, '/repo')).toMatchObject({ id: entryCommentId(log, 7), text: "Console error: TypeError: x is undefined", body: 'at render (Pricing.tsx:42:7)' })
  const request: NetworkEntry = { kind: 'network', id: 'r1', method: 'GET', url: 'http://localhost:3000/api/prices', resourceType: 'Fetch', status: 500, failed: null, mimeType: 'application/json', startedAt: 0, durationMs: 312, requestHeaders: { accept: 'application/json' }, responseHeaders: { 'content-type': 'application/json' }, postData: null }
  const comment = networkComment(request, 7, '{"error":"boom"}', page, '/repo')
  expect(comment.text).toBe('Request failed: GET http://localhost:3000/api/prices, 500 in 312 ms')
  expect(comment.body).toBe('Request headers:\naccept: application/json\n\nResponse headers:\ncontent-type: application/json\n\nResponse body:\n{"error":"boom"}')
})

test('vitalComment names the metric and the element', () => {
  const vital: Vital = { kind: 'vital', id: 'v1', name: 'CLS', value: 0.18, element: 'div.plan', detail: '', start: 0, time: 0 }
  expect(vitalComment(vital, 7, page, '/repo')).toMatchObject({ id: entryCommentId(vital, 7), text: 'Performance: CLS 0.18', body: 'Caused by: div.plan' })
})

test('entryCommentId differs per page and per launch, since entry ids restart', () => {
  const vital: Vital = { kind: 'vital', id: 'v1', name: 'CLS', value: 0.18, element: 'div.plan', detail: '', start: 0, time: 0 }
  expect(entryCommentId(vital, 7)).toMatch(/^browser:[a-z0-9]+:7:vital:v1$/)
  expect(entryCommentId(vital, 7)).not.toBe(entryCommentId(vital, 8))
})
