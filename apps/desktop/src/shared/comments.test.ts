import { expect, test } from 'bun:test'
import { commentsPrompt, extractFileLines, extractLines, formatComments, isReviewComment, rangeLabel, type ReviewComment } from './comments'

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

test('formatComments sends the location and the note, never the stored code', () => {
  const comment = { id: '1', worktreePath: '/r', filePath: 'a.ts', range: { start: 11, end: 11 }, code: '+new', text: ' rename \n' }
  expect(formatComments([comment])).toBe('1. a.ts:11\nrename')
  expect(isReviewComment(comment)).toBe(true)
  expect(isReviewComment({ ...comment, range: null })).toBe(false)
  const fileComment = { ...comment, kind: 'file' as const, code: 'plain' }
  expect(formatComments([fileComment])).toBe('1. a.ts:11\nrename')
  expect(formatComments([{ ...comment, range: { start: 9, end: 4 } }])).toBe('1. a.ts:4-9\nrename')
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

test('commentsPrompt sends references as-is and code notes as feedback on the code', () => {
  const base = { worktreePath: '/r', range: { start: 0, end: 0 }, code: '' }
  const reference: ReviewComment = { ...base, id: 'a', filePath: 'BF-627 Translations', text: 'Jira BF-627 https://x/browse/BF-627', kind: 'reference' }
  const note: ReviewComment = { ...base, id: 'b', filePath: 'src/a.ts', range: { start: 3, end: 3 }, code: '+x', text: 'rename x' }
  expect(commentsPrompt([reference], 'main (/r)')).toBe('Jira BF-627 https://x/browse/BF-627\n')
  const both = commentsPrompt([reference, note], 'main (/r)')
  expect(both).toBe('Jira BF-627 https://x/browse/BF-627\n\nFeedback on the code in main (/r). Address each note:\n\n1. src/a.ts:3\nrename x\n')
  expect(both).not.toContain('```')
})
