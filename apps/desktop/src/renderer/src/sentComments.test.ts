import { expect, test } from 'bun:test'
import type { ReviewComment } from '../../shared/comments'
import { addSent, restoreSent, type SentBatch } from './sentComments'

const comment = (id: string): ReviewComment => ({ id, worktreePath: '/repo', filePath: 'a.ts', range: { start: 1, end: 1 }, code: '', text: id, kind: 'file' })
const batch = (id: string, comments: ReviewComment[]): SentBatch => ({ id, sentAt: '2026-01-01T00:00:00Z', worktreePath: '/repo', message: 'Sent', comments })

test('addSent keeps the newest first and caps the history', () => {
  const many = Array.from({ length: 40 }, (_, index) => batch(`b${index}`, [])).reduce(addSent, [] as SentBatch[])
  expect(many.length).toBe(30)
  expect(many[0].id).toBe('b39')
})

test('restoreSent brings a batch back once and drops it from the history', () => {
  const history = [batch('one', [comment('a'), comment('b')]), batch('two', [comment('c')])]
  const restored = restoreSent(history, [comment('b')], 'one')
  expect(restored.comments.map((item) => item.id)).toEqual(['b', 'a'])
  expect(restored.batches.map((item) => item.id)).toEqual(['two'])
  expect(restoreSent(history, [], 'missing').batches).toBe(history)
})
