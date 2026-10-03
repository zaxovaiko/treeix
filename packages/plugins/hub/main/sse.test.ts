import { expect, test } from 'bun:test'
import { sseReader } from './sse'

test('events split anywhere come out whole, comments and other fields skipped', () => {
  const events: string[] = []
  const reader = sseReader((data) => events.push(data))
  for (const piece of [': keep-alive\n\nda', 'ta: {"a":1}\r\n', '\r\nevent: x\ndata: one\ndata:two\n', '\ndata: [DONE]\n\n']) reader.push(piece)
  expect(events).toEqual(['{"a":1}', 'one\ntwo', '[DONE]'])
})
