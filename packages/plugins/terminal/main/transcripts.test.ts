import { expect, test } from 'bun:test'
import { claudeUsage, codexUsage } from './transcripts'

test('claudeUsage counts each message once, across its content block lines', () => {
  const line = (id: string, usage: object): string => JSON.stringify({ message: { id, usage } })
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }
  const transcript = [line('a', usage), line('a', usage), line('b', { input_tokens: 1, output_tokens: 2 }), '{"type":"user"}', 'not json'].join('\n')
  expect(claudeUsage(transcript)).toEqual({ input: 16, cached: 100, output: 9 })
})

test('codexUsage takes the last running total, cached input apart', () => {
  const total = (input: number, cached: number, output: number): string =>
    JSON.stringify({ payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
  expect(codexUsage([total(10, 0, 1), total(500, 400, 30)].join('\n'))).toEqual({ input: 100, cached: 400, output: 30 })
  expect(codexUsage('')).toEqual({ input: 0, cached: 0, output: 0 })
})
