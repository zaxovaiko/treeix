import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type RequestPermissionOutcome } from '@agentclientprotocol/sdk'
import type { ChatEvent } from '@treeix/sdk/main'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confinedPath, connectOverStream, sliceLines } from './acpAdapter'

function fakeAgent() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent: { mode: string; outcome: RequestPermissionOutcome | null } = { mode: 'ask', outcome: null }
  let cancelArrived = () => undefined as void
  const cancelled = new Promise<void>((resolve) => (cancelArrived = resolve))

  const agentSide = new AgentSideConnection(
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
      loadSession: async ({ sessionId }) => {
        for (let index = 0; index <= 5000; index++) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: String(index) } } })
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } })
        return { modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] } }
      },
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

  // Aborting the pipe drops the agent's side, as when its process dies
  const disconnect = new AbortController()
  const fromAgent = toClient.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: disconnect.signal })
  return { clientStream: ndJsonStream(toAgent.writable, fromAgent), agent, agentSide, disconnect: () => disconnect.abort() }
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

test('a dropped agent settles a waiting permission and reports it', async () => {
  const { clientStream, disconnect } = fakeAgent()
  const connection = await connectOverStream(clientStream, { cwd: '/tmp', resume: null, close: () => undefined, stderrTail: () => 'crashed\n' })
  const events: ChatEvent[] = []
  connection.onEvent((event) => {
    events.push(event)
    if (event.type === 'permission') disconnect()
  })
  await connection.prompt([{ type: 'text', text: 'Hi' }])
  expect(events.map((event) => event.type)).toContain('permission_settled')
  expect(events).toContainEqual({ type: 'error', message: 'The agent stopped: crashed' })
})

test('file access stays inside the session folder', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'acp-fs-')))
  const root = join(base, 'x')
  await mkdir(root)
  await mkdir(join(base, 'xy'))
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(base, 'secret.txt'), 's')
  await symlink(join(base, 'secret.txt'), join(root, 'link.txt'))
  await symlink(join(base, 'nowhere.txt'), join(root, 'dangling.txt'))

  expect(await confinedPath(join(root, 'a.txt'), root, 'read')).toBe(join(root, 'a.txt'))
  expect(await confinedPath(join(root, 'new.txt'), root, 'write')).toBe(join(root, 'new.txt'))
  await expect(confinedPath(join(root, '..', 'secret.txt'), root, 'read')).rejects.toThrow('Outside the session folder')
  await expect(confinedPath(join(base, 'xy', 'b.txt'), root, 'write')).rejects.toThrow('Outside the session folder')
  await expect(confinedPath(join(root, 'link.txt'), root, 'read')).rejects.toThrow('Outside the session folder')
  await expect(confinedPath(join(root, 'link.txt'), root, 'write')).rejects.toThrow('Outside the session folder')
  await expect(confinedPath(join(root, 'dangling.txt'), root, 'write')).rejects.toThrow('Outside the session folder')
  await expect(confinedPath('a.txt', root, 'read')).rejects.toThrow('Path must be absolute')
})

test('read slicing takes a 1-based line and a line limit', () => {
  const content = 'one\ntwo\nthree\nfour'
  expect(sliceLines(content, null, null)).toBe(content)
  expect(sliceLines(content, 2, null)).toBe('two\nthree\nfour')
  expect(sliceLines(content, 2, 2)).toBe('two\nthree')
  expect(sliceLines(content, null, 1)).toBe('one')
})

test('a long replay keeps its newest events and the options', async () => {
  const { clientStream } = fakeAgent()
  const connection = await connectOverStream(clientStream, { cwd: '/tmp', resume: 's0', close: () => undefined })
  const events: ChatEvent[] = []
  connection.onEvent((event) => events.push(event))
  expect(connection.sessionId).toBe('s0')
  expect(events).toHaveLength(5001)
  expect(events[0]).toMatchObject({ type: 'options', options: [{ id: 'mode', currentValue: 'ask' }] })
  expect(events[1]).toEqual({ type: 'message_chunk', role: 'user', content: { type: 'text', text: '1' } })
  expect(events.at(-1)).toEqual({ type: 'message_chunk', role: 'user', content: { type: 'text', text: '5000' } })
})

test('writes create new files and overwrite existing ones inside the folder', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-write-')))
  const { clientStream, agentSide } = fakeAgent()
  await connectOverStream(clientStream, { cwd: root, resume: null, close: () => undefined })
  const path = join(root, 'n.txt')
  await agentSide.writeTextFile({ sessionId: 's1', path, content: 'one\ntwo' })
  await agentSide.writeTextFile({ sessionId: 's1', path, content: 'three\nfour' })
  expect(await agentSide.readTextFile({ sessionId: 's1', path, line: 2, limit: 1 })).toEqual({ content: 'four' })
  await expect(agentSide.writeTextFile({ sessionId: 's1', path: join(root, '..', 'out.txt'), content: 'x' })).rejects.toBeDefined()
})
