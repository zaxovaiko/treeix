// A stand-in ACP agent for chat e2e: it thinks for a moment, then answers with text and an image
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const THINKING_MS = 1500

new AgentSideConnection(
  (connection) => ({
    initialize: () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: true } } }),
    newSession: () => ({ sessionId: 'fake' }),
    authenticate: () => undefined,
    cancel: () => undefined,
    prompt: async ({ sessionId }) => {
      const update = (value) => connection.sessionUpdate({ sessionId, update: value })
      await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Pondering' } })
      await new Promise((resolve) => setTimeout(resolve, THINKING_MS))
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is a picture' } })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: PIXEL } })
      return { stopReason: 'end_turn' }
    }
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
)
