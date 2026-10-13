import { expect, test } from 'bun:test'
import { emitPluginEvent, onPluginEvent } from './events'

test('an event is taken only when a listener starts work for it', async () => {
  const seen: string[] = []
  const stopIgnoring = onPluginEvent(async (name) => (seen.push(name), false))
  const stopFailing = onPluginEvent(() => Promise.reject(new Error('down')))
  expect(await emitPluginEvent('slack.messages', {})).toBe(false)

  const stopTaking = onPluginEvent(async (name) => name === 'slack.messages')
  expect(await emitPluginEvent('slack.messages', {})).toBe(true)
  expect(await emitPluginEvent('meetings.transcribed', {})).toBe(false)

  stopTaking()
  expect(await emitPluginEvent('slack.messages', {})).toBe(false)
  expect(seen).toEqual(['slack.messages', 'slack.messages', 'meetings.transcribed', 'slack.messages'])
  stopIgnoring()
  stopFailing()
})
