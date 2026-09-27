import { expect, test } from 'bun:test'
import { screenText } from './agentTools'

test('screenText drops escapes, keeps what a carriage return overwrote last, and the tail', () => {
  const output = '\x1b]0;title\x07\x1b[32m$ \x1b[0mls\r\nfiles\r\nprogress 10%\rprogress 100%\r\n\r\n\r\n$ '
  expect(screenText(output, 60)).toBe('$ ls\nfiles\nprogress 100%\n\n$')
  expect(screenText(output, 1)).toBe('$')
})
