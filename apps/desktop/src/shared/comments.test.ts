import { expect, test } from 'bun:test'
import { extractFileLines, extractLines, formatComments, isReviewComment, rangeLabel } from './comments'

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@ fn
 keep
-old
+new
+added
 tail
`

test('extractLines', () => {
  expect(extractLines(patch, { start: 11, end: 12, side: 'additions' })).toBe('+new\n+added')
  expect(extractLines(patch, { start: 11, end: 11, side: 'deletions' })).toBe('-old')
  expect(extractLines(patch, { start: 11, side: 'deletions', end: 12, endSide: 'additions' })).toBe('-old\n+new\n+added')
  expect(extractLines(patch, { start: 13, end: 10, side: 'additions' })).toBe(' keep\n-old\n+new\n+added\n tail')
  expect(extractLines(patch, { start: 99, end: 99 })).toBe('')
})

test('rangeLabel', () => {
  expect(rangeLabel({ start: 4, end: 4 })).toBe('4')
  expect(rangeLabel({ start: 9, end: 4, side: 'deletions' })).toBe('4-9 (old)')
})

test('formatComments', () => {
  const comment = { id: '1', worktreePath: '/r', filePath: 'a.ts', range: { start: 11, end: 11 }, code: '+new', text: ' rename \n' }
  expect(formatComments([comment])).toBe('1. a.ts:11\n```diff\n+new\n```\nrename')
  expect(isReviewComment(comment)).toBe(true)
  expect(isReviewComment({ ...comment, range: null })).toBe(false)
  const fileComment = { ...comment, kind: 'file' as const, code: 'plain' }
  expect(formatComments([fileComment])).toBe('1. a.ts:11\n```\nplain\n```\nrename')
  expect(isReviewComment(fileComment)).toBe(true)
  const conversation = { ...comment, filePath: 'PR #12 conversation', range: { start: 0, end: 0 }, code: '' }
  expect(formatComments([conversation])).toBe('1. PR #12 conversation\nrename')
  const withFiles = { ...conversation, attachments: [{ path: '/data/a.png', name: 'a.png', thumbnail: 'data:image/jpeg;base64,x' }] }
  expect(formatComments([withFiles])).toBe('1. PR #12 conversation\nrename\nAttached files:\n- /data/a.png')
  expect(isReviewComment(withFiles)).toBe(true)
  expect(isReviewComment({ ...withFiles, attachments: [{ path: 1 }] })).toBe(false)
})

test('extractFileLines', () => {
  expect(extractFileLines('a\nb\nc\nd', { start: 3, end: 2 })).toBe('b\nc')
})
