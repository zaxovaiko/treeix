import { expect, test } from 'bun:test'
import { speakable } from './speech'

test('speakable drops markup and names code and tables instead of reading them', () => {
  const reply = [
    '## Done',
    'Fixed **the bug** in `store.ts`, see [the PR](https://github.com/a/b/pull/1) or https://example.com.',
    '```ts',
    'const a = 1',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '- first_item',
    '1. Should I *push* it?'
  ].join('\n')
  expect(speakable(reply)).toBe(['Done', 'Fixed the bug in store.ts, see the PR or a link', 'A code block.', 'A table.', 'first_item', 'Should I push it?'].join('\n'))
})
