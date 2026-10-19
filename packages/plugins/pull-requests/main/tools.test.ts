import { expect, test } from 'bun:test'
import type { ReviewEvent, ReviewThread, ThreadComment } from '../shared/types'
import { changesRequestedAt, openComments } from './tools'

const comment = (id: string, body: string): ThreadComment => ({
  id,
  author: 'ana',
  avatarUrl: null,
  body,
  createdAt: '',
  reactions: { '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 }
})
const thread = (id: string, resolved: boolean | null, comments: ThreadComment[]): ReviewThread => ({
  id,
  path: 'a.ts',
  line: 3,
  side: 'additions',
  comments,
  resolved,
  resolveId: null
})

test('openComments keeps the comments of open threads and the conversation, without blank ones', () => {
  const threads = [
    thread('t1', false, [comment('review:1', 'Rename this'), comment('review:2', 'Agent: renamed')]),
    thread('t2', true, [comment('review:3', 'ok')]),
    thread('t3', null, [comment('pullreview:4', ' '), comment('issue:5', 'Add a test')])
  ]
  expect(openComments(threads).map((found) => [found.id, found.threadId])).toEqual([
    ['review:1', 't1'],
    ['review:2', 't1'],
    ['issue:5', 't3']
  ])
})

test('changesRequestedAt is the newest change request of reviewers who still want changes', () => {
  const event = (author: string, verdict: ReviewEvent['verdict'], createdAt: string): ReviewEvent => ({ author, avatarUrl: null, verdict, createdAt })
  expect(changesRequestedAt([])).toBeNull()
  expect(changesRequestedAt([event('ana', 'changes', '2026-01-01'), event('ana', 'approved', '2026-01-02')])).toBeNull()
  expect(changesRequestedAt([event('ana', 'changes', '2026-01-01'), event('bo', 'changes', '2026-01-03'), event('bo', 'approved', '2026-01-04')])).toBe('2026-01-01')
  expect(changesRequestedAt([event('ana', 'changes', '2026-01-01'), event('ana', 'changes', '2026-01-05')])).toBe('2026-01-05')
})
