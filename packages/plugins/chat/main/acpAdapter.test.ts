import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type RequestPermissionOutcome } from '@agentclientprotocol/sdk'
import type { ChatEvent } from '@treeix/sdk/main'
import { expect, test } from 'bun:test'
import { connectOverStream } from './acpAdapter'

function fakeAgent() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent: { mode: string; outcome: RequestPermissionOutcome | null } = { mode: 'ask', outcome: null }
  let cancelArrived = () => undefined as void
  const cancelled = new Promise<void>((resolve) => (cancelArrived = resolve))

  new AgentSideConnection(
    (connection) => ({
      initialize: () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }),
      newSession: () => ({
        sessionId: 's1',
        modes: {
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: 'Ask' },
            { id: 'code', name: 'Code' }
          ]
        }
      }),
      authenticate: () => undefined,
      prompt: async ({ sessionId }) => {
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } })
        const { outcome } = await connection.requestPermission({
          sessionId,
          toolCall: { toolCallId: 't1', title: 'Edit file' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        })
        agent.outcome = outcome
        if (outcome.outcome === 'cancelled') {
          await cancelled
          return { stopReason: 'cancelled' }
        }
        const status = outcome.optionId === 'allow' ? 'completed' : 'failed'
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit file', status } })
        return { stopReason: 'end_turn' }
      },
      cancel: () => cancelArrived(),
      setSessionMode: ({ modeId }) => {
        agent.mode = modeId
      }
    }),
    ndJsonStream(toClient.writable, toAgent.readable)
  )

  return { clientStream: ndJsonStream(toAgent.writable, toClient.readable), agent }
}

test('a turn streams events, asks permission and ends', async () => {
  const { clientStream, agent } = fakeAgent()
  const connection = await connectOverStream(clientStream, { cwd: '/tmp', resume: null, close: () => undefined })
  const events: ChatEvent[] = []
  connection.onEvent((event) => {
    events.push(event)
    if (event.type === 'permission') connection.answer(event.requestId, event.options.find((option) => option.kind === 'allow_once')?.id ?? null)
  })
  expect(connection.sessionId).toBe('s1')
  expect(connection.capabilities).toEqual({ images: true, load: true, list: false })
  const { stopReason } = await connection.prompt([{ type: 'text', text: 'Hi' }])
  expect(stopReason).toBe('end_turn')
  expect(events.map((event) => event.type)).toEqual(['options', 'turn_start', 'message_chunk', 'permission', 'permission_settled', 'tool_call', 'turn_end'])
  expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ call: { id: 't1', status: 'completed' } })
  await connection.setOption('mode', 'code')
  expect(agent.mode).toBe('code')
  expect(events.at(-1)).toMatchObject({ type: 'options', options: [{ id: 'mode', currentValue: 'code' }] })
})

test('cancel settles a waiting permission as cancelled', async () => {
  const { clientStream, agent } = fakeAgent()
  const connection = await connectOverStream(clientStream, { cwd: '/tmp', resume: null, close: () => undefined })
  const events: ChatEvent[] = []
  connection.onEvent((event) => {
    events.push(event)
    if (event.type === 'permission') connection.cancel()
  })
  const { stopReason } = await connection.prompt([{ type: 'text', text: 'Hi' }])
  expect(stopReason).toBe('cancelled')
  expect(agent.outcome).toEqual({ outcome: 'cancelled' })
  expect(events.map((event) => event.type)).toEqual(['options', 'turn_start', 'message_chunk', 'permission', 'permission_settled', 'turn_end'])
  expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'cancelled' })
})
