import { expect, test } from 'bun:test'
import { gutterMarks } from './gutter'

test('the gutter marks added, modified and removed lines by their new line number', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n'
  const current = 'a\nB\nc\nd\ne\nf\ng\nh\nnew\ni\nj\nk\nm\n'
  expect(gutterMarks(base, current)).toEqual({ added: [9], modified: [2], removed: [{ after: 12, lines: ['l'] }] })
})

test('a removal at the top sits above line 1; identical text has no marks', () => {
  expect(gutterMarks('x\ny\n', 'y\n').removed).toEqual([{ after: 0, lines: ['x'] }])
  expect(gutterMarks('same\n', 'same\n')).toEqual({ added: [], modified: [], removed: [] })
})
