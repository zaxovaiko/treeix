import { afterAll, expect, test } from 'bun:test'
import type { ChatEvent } from '@treeix/sdk/main'
import { createOpenAiAdapter } from './openaiAdapter'

const bodies: unknown[] = []
const keys: (string | null)[] = []
const chunk = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    keys.push(request.headers.get('authorization'))
    const { pathname } = new URL(request.url)
    if (pathname === '/v1/models') return Response.json({ data: [{ id: 'small', name: 'Small', context_length: 1000 }, { id: 'big' }] })
    bodies.push(await request.json())
    const stream = [
      chunk({ choices: [{ delta: { reasoning: 'Hmm' } }] }),
      chunk({ choices: [{ delta: { content: 'Hel' } }] }),
      chunk({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
      chunk({ choices: [], usage: { total_tokens: 42, cost: 0.5 } }),
      'data: [DONE]\n\n'
    ]
    return new Response(stream.join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
})
afterAll(() => server.stop())

const adapter = createOpenAiAdapter(async () => 'sk-test')
const connect = (model?: string) =>
  adapter.connect({ command: `http://localhost:${server.port}/v1/`, instructions: 'Be brief', preset: model ? { model } : {}, cwd: '/', env: {}, resume: null })

test('streams thinking, text and usage, and sends the whole conversation each turn', async () => {
  const connection = await connect('small')
  const events: ChatEvent[] = []
  connection.onEvent((event) => events.push(event))
  expect(events[0]).toMatchObject({ type: 'options', options: [{ currentValue: 'small', values: [{ value: 'small', name: 'Small' }, { value: 'big' }] }] })

  expect(await connection.prompt([{ type: 'text', text: 'Hi' }])).toEqual({ stopReason: 'end_turn' })
  expect(events.slice(1)).toEqual([
    { type: 'turn_start' },
    { type: 'thought_chunk', text: 'Hmm' },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'Hel' } },
    { type: 'message_chunk', role: 'agent', content: { type: 'text', text: 'lo' } },
    { type: 'usage', used: 42, size: 1000, cost: { amount: 0.5, currency: 'USD' } },
    { type: 'turn_end', stopReason: 'end_turn' }
  ])

  await connection.setOption('model', 'big')
  await connection.prompt([{ type: 'text', text: 'Again' }])
  expect(bodies.at(-1)).toMatchObject({
    model: 'big',
    stream: true,
    messages: [
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: [{ type: 'text', text: 'Again' }] }
    ]
  })
  expect(keys.every((key) => key === 'Bearer sk-test')).toBe(true)
  connection.close()
})

test('a provider error shows as the turn error and leaves no trace in the history', async () => {
  const failing = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 }) })
  const connection = await createOpenAiAdapter(async () => null).connect({ command: `http://localhost:${failing.port}/v1`, cwd: '/', env: {}, resume: null })
  const events: ChatEvent[] = []
  connection.onEvent((event) => events.push(event))
  expect(await connection.prompt([{ type: 'text', text: 'Hi' }])).toEqual({ stopReason: 'cancelled' })
  expect(events).toContainEqual({ type: 'error', message: '401 No auth credentials found' })
  failing.stop()
})
