import { expect, test } from 'bun:test'
import { claudeRows, codexRows, codexTitles, localDay, projectOf } from './usage'
import { priceOf, reducePrices } from './prices'

const at = '2026-10-16T12:00:00.000Z'
const day = localDay(at) ?? ''

test('projectOf folds worktrees into their repository and shortens home', () => {
  expect(projectOf('/Users/me/code/app/.claude/worktrees/feat+x', '/Users/me')).toBe('~/code/app')
  expect(projectOf('/opt/app', '/Users/me')).toBe('/opt/app')
  expect(projectOf('', '/Users/me')).toBe('unknown')
})

test('claudeRows counts each reply once, skips synthetic ones and keeps the title the user set', async () => {
  const reply = (id: string, model = 'claude-opus-5-5') =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      cwd: '/opt/app',
      sessionId: 's1',
      requestId: `req_${id}`,
      message: {
        id,
        model,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20
        }
      }
    })
  const title = (type: string, key: string, name: string) => JSON.stringify({ type, [key]: name, sessionId: 's1' })
  const { rows, titles } = await claudeRows([
    title('ai-title', 'aiTitle', 'Generated'),
    title('custom-title', 'customTitle', 'Mine'),
    title('ai-title', 'aiTitle', 'Generated later'),
    reply('a'),
    reply('a'),
    reply('b'),
    reply('c', '<synthetic>'),
    '{"type":"user"}',
    'not json "usage"'
  ])
  expect(titles).toEqual({ s1: 'Mine' })
  expect(rows).toEqual([
    {
      day,
      agent: 'claude',
      model: 'claude-opus-5-5',
      project: '/opt/app',
      session: 's1',
      input: 20,
      output: 10,
      cacheRead: 200,
      cacheWrite: 40
    }
  ])
})

test('codexRows adds what each cumulative total grew by and names Ollama sessions', async () => {
  const count = (input: number, cached: number, output: number) =>
    JSON.stringify({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            total_tokens: input + output
          },
          last_token_usage: {
            input_tokens: 7,
            cached_input_tokens: 0,
            output_tokens: 1,
            total_tokens: 8
          }
        }
      }
    })
  const meta = (provider: string) =>
    JSON.stringify({
      timestamp: at,
      type: 'session_meta',
      payload: { id: 'c1', cwd: '/opt/app', model_provider: provider }
    })
  const turn = JSON.stringify({
    timestamp: at,
    type: 'turn_context',
    payload: { model: 'gpt-6-luna' }
  })
  const row = { day, model: 'gpt-6-luna', project: '/opt/app', session: 'c1', cacheWrite: 0 }
  // The repeated total adds nothing; the one that shrank falls back to the turn's own usage
  expect((await codexRows([meta('openai'), turn, count(100, 40, 10), count(100, 40, 10), count(250, 140, 30), count(50, 0, 5)])).rows).toEqual([
    { ...row, agent: 'codex', input: 117, output: 31, cacheRead: 140 }
  ])
  expect((await codexRows([meta('ollama-launch'), turn, count(100, 0, 10)])).rows[0]?.agent).toBe('ollama')
})

test('codexTitles takes the latest name of each thread', async () => {
  const name = (id: string, thread_name: string) => JSON.stringify({ id, thread_name })
  expect(await codexTitles([name('c1', 'First'), name('c2', 'Other'), name('c1', 'Renamed'), 'broken'])).toEqual({ c1: 'Renamed', c2: 'Other' })
})

test('reducePrices keeps bare model names and falls back to the input price for cache', () => {
  const prices = reducePrices({
    'claude-opus-5-5': {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 2e-5,
      cache_read_input_token_cost: 2e-7,
      cache_creation_input_token_cost: 5e-6
    },
    'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
    'azure/gpt-5.5': { input_cost_per_token: 1, output_cost_per_token: 1 },
    sample_spec: { max_tokens: 'set to max' }
  })
  expect(prices).toEqual({
    'claude-opus-5-5': [4e-6, 2e-5, 2e-7, 5e-6],
    'gpt-5.5': [5e-6, 3e-5, 5e-6, 5e-6]
  })
  expect(priceOf({ 'claude-haiku-4-5': [1, 2, 3, 4] }, 'claude-haiku-4-5-20251001')).toEqual([1, 2, 3, 4])
  expect(priceOf(prices, 'gemma4:26b-mlx')).toBeNull()
})
