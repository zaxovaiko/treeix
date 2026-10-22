import { beforeEach, expect, test } from 'bun:test'
import { addComment, clearComments, COMMENTS_KEY, deleteComment, extractFileLines, getComments, isReviewComment, linesLabel } from './comments'

const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  length: 0
}

beforeEach(() => getComments().forEach((comment) => deleteComment(comment.id)))

test('a range picks its lines, in either order', () => {
  expect(extractFileLines('a\nb\nc\nd', { start: 2, end: 3 })).toBe('b\nc')
  expect(extractFileLines('a\nb\nc\nd', { start: 3, end: 2 })).toBe('b\nc')
  expect(linesLabel({ start: 4, end: 4 })).toBe('Line 4')
  expect(linesLabel({ start: 9, end: 4 })).toBe('Lines 4-9')
})

test('comments persist and clear per checkout', () => {
  addComment({ worktreePath: '/a', filePath: 'x.ts', range: { start: 1, end: 1 }, code: 'x', text: 'one' })
  addComment({ worktreePath: '/b', filePath: 'y.ts', range: { start: 2, end: 3 }, code: 'y', text: 'two' })
  const saved: unknown = JSON.parse(store.get(COMMENTS_KEY) ?? '[]')
  expect(Array.isArray(saved) && saved.every(isReviewComment)).toBe(true)
  clearComments('/a')
  expect(getComments().map((comment) => comment.text)).toEqual(['two'])
})

test('stored junk is not a comment', () => {
  expect(isReviewComment({ id: '1', worktreePath: '/a', filePath: 'x', code: '', text: 't', range: { start: 1, end: 1 }, kind: 'file' })).toBe(true)
  expect(isReviewComment({ id: '1', worktreePath: '/a', filePath: 'x', code: '', text: 't', range: null, kind: 'file' })).toBe(false)
  expect(isReviewComment('nope')).toBe(false)
})
