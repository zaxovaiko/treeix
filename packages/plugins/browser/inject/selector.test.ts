import { expect, test } from 'bun:test'
import { selectorFor } from './selector'

test('selectorFor stops at the first unique selector, preferring ids', () => {
  const steps = [
    { tag: 'span', id: '', nth: 1, sameTagSiblings: 1 },
    { tag: 'div', id: '', nth: 2, sameTagSiblings: 3 },
    { tag: 'main', id: 'app', nth: 1, sameTagSiblings: 1 }
  ]
  const unique = new Set(['#app > div:nth-of-type(2) > span'])
  expect(selectorFor(steps, (selector) => unique.has(selector))).toBe('#app > div:nth-of-type(2) > span')
  expect(selectorFor(steps, (selector) => selector === 'div:nth-of-type(2) > span')).toBe('div:nth-of-type(2) > span')
  expect(selectorFor(steps, () => false)).toBe('#app > div:nth-of-type(2) > span')
})

test('selectorFor ignores ids that need escaping', () => {
  expect(selectorFor([{ tag: 'p', id: '1:weird', nth: 1, sameTagSiblings: 1 }], () => true)).toBe('p')
})
