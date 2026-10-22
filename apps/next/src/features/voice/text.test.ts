import { expect, test } from 'bun:test'
import { clock, formatVocabulary, hotkeyLabel, parseVocabulary } from './text'

test('clock counts minutes, then hours', () => {
  expect(clock(0)).toBe('0:00')
  expect(clock(65_400)).toBe('1:05')
  expect(clock(3_725_000)).toBe('1:02:05')
  expect(clock(-5)).toBe('0:00')
})

test('hotkey labels name each side', () => {
  expect(hotkeyLabel(['MetaLeft', 'AltRight'])).toBe('Left ⌘ Right ⌥')
  expect(hotkeyLabel(['Fn'])).toBe('Fn')
})

test('vocabulary round-trips through its text form', () => {
  const terms = [
    { text: 'GitHub', aliases: ['git hub'] },
    { text: 'Treeix', aliases: ['трікс', 'tricks'] },
    { text: 'Claude', aliases: [] },
  ]
  expect(parseVocabulary(formatVocabulary(terms))).toEqual(terms)
  expect(parseVocabulary(' a : b ,, c \n\n : orphan\nTRX: 12:30')).toEqual([
    { text: 'a', aliases: ['b', 'c'] },
    { text: 'TRX', aliases: ['12:30'] },
  ])
})
