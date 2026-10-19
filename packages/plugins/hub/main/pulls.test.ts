import { expect, test } from 'bun:test'
import { freshTicketState } from '../shared/tickets'
import { MAX_CI_FIXES, nextAction, type PullComment, type PullStatus, reviewComments, unansweredIds } from './pulls'

const open = (ci: 'passed' | 'failed' | 'running' | null): PullStatus => ({ state: 'open', sourceBranch: 'BF-1', pipeline: ci ? { status: ci } : null })
const comment = (id: string, body: string, threadId?: string): PullComment => ({ id, threadId, author: 'ana', body, path: null, line: null })
const fresh = freshTicketState('BF-1')

test('a merge finishes the ticket, a close waits for a person once', () => {
  const merged = nextAction(fresh, { ...open(null), state: 'merged' }, 0, 9)
  expect([merged.action, merged.state.mergedAt]).toEqual(['done', 9])
  const closed = nextAction(fresh, { ...open(null), state: 'closed' }, 0, 9)
  expect(closed.action).toBe('needsYou')
  expect(nextAction(closed.state, { ...open(null), state: 'closed' }, 0, 10).action).toBeNull()
})

test('failing CI gets fixed after the last push settled, three times at most, and green resets it', () => {
  expect(nextAction(fresh, open('failed'), 100, 50).action).toBeNull()
  let state = fresh
  for (let fix = 1; fix <= MAX_CI_FIXES; fix++) {
    const step = nextAction(state, open('failed'), 0, fix)
    expect([step.action, step.state.ciFixes]).toEqual(['ci', fix])
    state = step.state
  }
  const capped = nextAction(state, open('failed'), 0, 9)
  expect([capped.action, capped.state.needsYou]).toEqual(['needsYou', `CI still fails after ${MAX_CI_FIXES} fixes`])
  expect(nextAction(capped.state, open('failed'), 0, 10).action).toBeNull()
  const green = nextAction(capped.state, open('passed'), 0, 11)
  expect([green.action, green.state.ciFixes, green.state.needsYou]).toEqual([null, 0, null])
})

test('a change request gets one fix with every open comment', () => {
  const requested = (at: string | null): PullStatus => ({ ...open('passed'), changesRequestedAt: at })
  expect(nextAction(fresh, open('passed'), 0, 1).action).toBeNull()
  const first = nextAction(fresh, requested('t1'), 0, 1)
  expect([first.action, first.state.changesRequestedAt]).toEqual(['review', 't1'])
  expect(nextAction(first.state, requested('t1'), 0, 2).action).toBeNull()
  const approved = nextAction(first.state, requested(null), 0, 3)
  expect([approved.action, approved.state.changesRequestedAt]).toEqual([null, null])
  expect(nextAction(approved.state, requested('t2'), 0, 4).action).toBe('review')
  const comments = [comment('review:1', 'Rename this'), comment('review:2', '  Agent: renamed'), comment('issue:3', 'Add a test')]
  expect(reviewComments(comments).map((found) => found.id)).toEqual(['review:1', 'issue:3'])
})

test('a thread nobody answered gets one fix once nothing new came in for a check', () => {
  const waiting = (...unanswered: string[]): PullStatus => ({ ...open('passed'), unanswered })
  const seen = nextAction(fresh, waiting('c1'), 0, 1)
  expect(seen.action).toBeNull()
  const more = nextAction(seen.state, waiting('c1', 'c2'), 0, 2)
  expect(more.action).toBeNull()
  const fix = nextAction(more.state, waiting('c1', 'c2'), 0, 3)
  expect([fix.action, fix.state.answering]).toEqual(['review', ['c1', 'c2']])
  expect(nextAction(fix.state, waiting('c1', 'c2'), 0, 4).action).toBeNull()
  const answered = nextAction(fix.state, waiting(), 0, 5)
  expect(nextAction(answered.state, waiting(), 0, 6).action).toBeNull()
  const reply = nextAction(answered.state, waiting('c3'), 0, 7)
  expect(nextAction(reply.state, waiting('c3'), 0, 8).action).toBe('review')
  const requested = nextAction(fresh, { ...waiting('c1'), changesRequestedAt: 't1' }, 0, 1)
  expect(nextAction(requested.state, { ...waiting('c1'), changesRequestedAt: 't1' }, 0, 2).action).toBeNull()
})

test('a thread waits for an answer until its last comment is an agent reply', () => {
  const comments = [
    comment('1', 'Rename this', 'a'),
    comment('2', 'Agent: renamed', 'a'),
    comment('3', 'Add a test', 'b'),
    comment('4', 'Agent: added', 'c'),
    comment('5', 'Still wrong', 'c'),
    comment('6', 'Typo')
  ]
  expect(unansweredIds(comments)).toEqual(['3', '5', '6'])
})

test('everything it does lands in the log', () => {
  const step = nextAction(fresh, open('failed'), 0, 5)
  expect(step.state.log).toEqual([
    { at: 5, text: 'CI failed' },
    { at: 5, text: `CI fix 1 of ${MAX_CI_FIXES} started` }
  ])
})
