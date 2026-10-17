import { expect, test } from 'bun:test'
import type { Run } from '../shared/workflow'
import { deciderOf, marker, parseVerdict, ticketThread } from './decisions'

const tag = marker('r1', 'gate')
const at = (minute: number): string => `2026-10-17T10:0${minute}:00.000+0200`

test('a ticket reply counts only under the latest question, and only when it opens with approve or reject', () => {
  expect(ticketThread([{ created: at(1), body: 'approve' }], tag)).toEqual({ asked: false })
  const asked = { created: at(2), body: `Treeix needs a decision ${tag}: Ship?` }
  expect(ticketThread([asked, { created: at(3), body: 'Why?' }], tag)).toEqual({ asked: true, reply: null })
  // Treeix's own comments carry a marker, so they never count as the reply, whoever posted them
  expect(ticketThread([asked, { created: at(3), body: 'Treeix needs a decision [treeix:r2:gate]: approve' }], tag)).toEqual({ asked: true, reply: null })
  expect(ticketThread([{ created: at(4), body: '**Approved**, ship it' }, asked, { created: at(1), body: 'reject old' }], tag)).toEqual({
    asked: true,
    reply: { approved: true, reason: 'ship it' }
  })
  expect(ticketThread([asked, { created: at(3), body: 'rejected' }], tag)).toEqual({ asked: true, reply: { approved: false, reason: null } })
  expect(ticketThread([asked, { created: at(3), body: 'approve' }, { created: at(4), body: `Treeix decision ${tag}: Approved` }], tag)).toEqual({ asked: false })
})

test("an agent's verdict is read from its JSON, and anything else rejects", () => {
  expect(parseVerdict('Sure.\n```json\n{"approve": true, "reason": "Tests pass"}\n```')).toEqual({ approved: true, reason: 'Tests pass' })
  expect(parseVerdict('I approve')).toMatchObject({ approved: false, reason: expect.stringContaining('not a decision') })
  expect(parseVerdict('{"approve": "yes"}').approved).toBe(false)
})

test("the decider is the step's own agent, else the one feeding it, or the workflow's first", () => {
  const agent = (id: string) => ({ id, kind: 'agent' as const, agent: `${id}-agent`, prompt: '', folder: null, retries: 0, onError: 'stop' as const, timeoutMin: 1 })
  const run = {
    workflow: {
      nodes: [agent('plan'), agent('build'), { id: 'gate', kind: 'approval' as const, message: '' }, { id: 'lone', kind: 'approval' as const, message: '' }],
      edges: [{ id: 'e', from: 'build', to: 'gate', branch: null }]
    }
  } as unknown as Run
  expect(deciderOf(run, 'build')).toBe('build-agent')
  expect(deciderOf(run, 'gate')).toBe('build-agent')
  expect(deciderOf(run, 'lone')).toBe('plan-agent')
})
