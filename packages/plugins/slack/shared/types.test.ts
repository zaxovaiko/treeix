import { expect, test } from 'bun:test'
import { triggerOf } from './types'

const workflow = (input: Record<string, unknown>): Record<string, unknown> => ({ nodes: [{ id: 'in', kind: 'input', ...input }] })

test('without a workflow on slack.messages the defaults apply', () => {
  expect(triggerOf('No workflows yet')).toEqual({ intervalMin: 15, includeOwn: true })
  expect(triggerOf([workflow({ events: ['meetings.transcribed'], slack: { intervalMin: 5, includeOwn: false } })])).toEqual({ intervalMin: 15, includeOwn: true })
})

test('several workflows get the shortest interval, and own messages when any wants them', () => {
  const workflows = [
    workflow({ events: ['slack.messages'], slack: { intervalMin: 30, includeOwn: false } }),
    workflow({ events: ['slack.messages'], slack: { intervalMin: 5, includeOwn: true } })
  ]
  expect(triggerOf(workflows)).toEqual({ intervalMin: 5, includeOwn: true })
  expect(triggerOf([workflows[0]])).toEqual({ intervalMin: 30, includeOwn: false })
})

test('options a workflow leaves out or garbles fall back to the defaults', () => {
  expect(triggerOf([workflow({ events: ['slack.messages'] })])).toEqual({ intervalMin: 15, includeOwn: true })
  expect(triggerOf([workflow({ events: ['slack.messages'], slack: { intervalMin: 0.5, includeOwn: 'no' } })])).toEqual({ intervalMin: 15, includeOwn: true })
})
