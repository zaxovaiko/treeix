import { expect, test } from 'bun:test'
import { freshTicketState } from '../shared/tickets'
import { MAX_CI_FIXES, nextAction, type PullComment, type PullStatus } from './pulls'

const open = (ci: 'passed' | 'failed' | 'running' | null): PullStatus => ({ state: 'open', sourceBranch: 'BF-1', pipeline: ci ? { status: ci } : null })
const comment = (id: string, body: string): PullComment => ({ id, author: 'ana', body, path: null, line: null })
const fresh = freshTicketState('BF-1')

test('a merge finishes the ticket, a close waits for a person once', () => {
  const merged = nextAction(fresh, { ...open(null), state: 'merged' }, [], 0, 9)
  expect([merged.action, merged.state.mergedAt]).toEqual(['done', 9])
  const closed = nextAction(fresh, { ...open(null), state: 'closed' }, [], 0, 9)
  expect(closed.action).toBe('needsYou')
  expect(nextAction(closed.state, { ...open(null), state: 'closed' }, [], 0, 10).action).toBeNull()
})

test('failing CI gets fixed after the last push settled, three times at most, and green resets it', () => {
  expect(nextAction(fresh, open('failed'), [], 100, 50).action).toBeNull()
  let state = fresh
  for (let fix = 1; fix <= MAX_CI_FIXES; fix++) {
    const step = nextAction(state, open('failed'), [], 0, fix)
    expect([step.action, step.state.ciFixes]).toEqual(['ci', fix])
    state = step.state
  }
  const capped = nextAction(state, open('failed'), [], 0, 9)
  expect([capped.action, capped.state.needsYou]).toEqual(['needsYou', `CI still fails after ${MAX_CI_FIXES} fixes`])
  expect(nextAction(capped.state, open('failed'), [], 0, 10).action).toBeNull()
  const green = nextAction(capped.state, open('passed'), [], 0, 11)
  expect([green.action, green.state.ciFixes, green.state.needsYou]).toEqual([null, 0, null])
})

test("new review comments get one fix, never the agent's own replies or ones already handed over", () => {
  const comments = [comment('review:1', 'Rename this'), comment('review:2', 'Agent: renamed'), comment('issue:3', 'Add a test')]
  const first = nextAction(fresh, open('passed'), comments, 0, 1)
  expect([first.action, first.comments.map((found) => found.id)]).toEqual(['review', ['review:1', 'issue:3']])
  expect(nextAction(first.state, open('passed'), comments, 0, 2).action).toBeNull()
  const later = nextAction(first.state, open('passed'), [...comments, comment('review:4', 'And this')], 0, 3)
  expect(later.comments.map((found) => found.id)).toEqual(['review:4'])
})

test('everything it does lands in the log', () => {
  const step = nextAction(fresh, open('failed'), [], 0, 5)
  expect(step.state.log).toEqual([
    { at: 5, text: 'CI failed' },
    { at: 5, text: `CI fix 1 of ${MAX_CI_FIXES} started` }
  ])
})
