import { expect, test } from 'bun:test'
import { isHumanMessage, permalink, render, withNames } from './messages'

test('only messages people wrote count', () => {
  expect(isHumanMessage({ type: 'message', text: 'hi', user: 'U1' })).toBe(true)
  expect(isHumanMessage({ type: 'message', subtype: 'thread_broadcast', text: 'hi' })).toBe(true)
  expect(isHumanMessage({ type: 'message', subtype: 'message_changed', text: 'hi' })).toBe(false)
  expect(isHumanMessage({ type: 'message', bot_id: 'B1', text: 'hi' })).toBe(false)
  expect(isHumanMessage({ type: 'message', text: '  ' })).toBe(false)
})

test('a message renders numbered with its channel, thread and time, linked by its ts', async () => {
  const ts = `${new Date(2026, 9, 14, 14, 5).getTime() / 1000}.000200`
  const text = await withNames('<@U1> check <@U2|bob>', async (id) => (id === 'U1' ? 'Me' : 'Bob'))
  expect(text).toBe('@Me check @Bob')
  expect(render([{ channel: '#dev', user: 'Anna', text, ts, permalink: '', thread: true }])).toBe('[1] #dev (thread reply) 14:05 Anna: @Me check @Bob')
  expect(permalink('https://x.slack.com/', 'C1', '1760443500.000200')).toBe('https://x.slack.com/archives/C1/p1760443500000200')
})
