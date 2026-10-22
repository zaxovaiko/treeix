import { expect, test } from 'bun:test'
import type { BrowserEntry } from '../../ipc/api'
import { mergeEntries } from './open'

const request = (id: string, status: number | null): BrowserEntry => ({ kind: 'network', id, method: 'GET', url: `http://x/${id}`, status, failed: null, startedAt: 0, durationMs: null })

test('mergeEntries replaces a finished request in place, appends new rows and starts over on reset', () => {
  const list = mergeEntries([], [request('a', null), request('b', null)], false)
  expect(mergeEntries(list, [request('a', 200), request('c', null)], false).map((e) => e.kind === 'network' && `${e.id}:${e.status}`)).toEqual(['a:200', 'b:null', 'c:null'])
  expect(mergeEntries(list, [request('d', 404)], true).map((e) => e.id)).toEqual(['d'])
})
