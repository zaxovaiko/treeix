import { expect, test } from 'bun:test'
import { sentenceAt } from './sentence'

test('sentenceAt finds the sentence being spoken', () => {
  const text = 'Fixed it. Should I push?\nDone'
  const at = (index: number): string => text.slice(sentenceAt(text, index).start, sentenceAt(text, index).end).trim()
  expect(at(0)).toBe('Fixed it.')
  expect(at(8)).toBe('Fixed it.')
  expect(at(12)).toBe('Should I push?')
  expect(at(text.length)).toBe('Done')
})
