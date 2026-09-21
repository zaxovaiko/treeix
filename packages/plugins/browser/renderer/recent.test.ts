import { expect, test } from 'bun:test'
import { parseRecent, RECENT_LIMIT, withTitle, withVisit } from './recent'

test('a visit goes first, once per URL, keeping the known title', () => {
  const list = [
    { url: 'https://a.dev/', title: 'A' },
    { url: 'https://b.dev/', title: 'B' }
  ]
  expect(withVisit(list, 'https://b.dev/')).toEqual([
    { url: 'https://b.dev/', title: 'B' },
    { url: 'https://a.dev/', title: 'A' }
  ])
})

test('keeps only the newest visits', () => {
  let list = withVisit([], 'https://first.dev/')
  for (let index = 0; index < RECENT_LIMIT; index++) list = withVisit(list, `https://site${index}.dev/`)
  expect(list).toHaveLength(RECENT_LIMIT)
  expect(list.some((entry) => entry.url === 'https://first.dev/')).toBe(false)
})

test('skips blank and non-web pages', () => {
  expect(withVisit([], 'about:blank')).toEqual([])
  expect(withVisit([], 'file:///etc/hosts')).toEqual([])
})

test('a title updates its entry without moving it', () => {
  const list = [
    { url: 'https://a.dev/', title: '' },
    { url: 'https://b.dev/', title: '' }
  ]
  expect(withTitle(list, 'https://b.dev/', 'B')).toEqual([
    { url: 'https://a.dev/', title: '' },
    { url: 'https://b.dev/', title: 'B' }
  ])
})

test('parses stored JSON defensively', () => {
  expect(parseRecent('not json')).toEqual([])
  expect(parseRecent('[{"url":"https://a.dev/","title":"A"},{"url":1},null]')).toEqual([{ url: 'https://a.dev/', title: 'A' }])
})
