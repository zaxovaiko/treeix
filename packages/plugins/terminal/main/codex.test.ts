import { expect, test } from 'bun:test'
import { parseRolloutHead } from './codex'

test('parseRolloutHead reads the id, folder and start of a Codex conversation', () => {
  const head = `${JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: '/repo', timestamp: '2026-09-19T10:01:26.305Z' } })}\n{"partial":`
  expect(parseRolloutHead(head)).toEqual({ id: 'abc', cwd: '/repo', startedAt: Date.parse('2026-09-19T10:01:26.305Z') })
  expect(parseRolloutHead('{"type":"other"}')).toBeNull()
})
