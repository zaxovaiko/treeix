import { expect, test } from 'bun:test'
import { chooseZone } from './layout'

type Fake = { id: string; shown: boolean; inside: string[] }

const shown = (zone: Fake): boolean => zone.shown
const contains = (outer: Fake, inner: Fake): boolean => outer.inside.includes(inner.id)

test('chooseZone takes the innermost zone that is on screen', () => {
  const shell: Fake = { id: 'shell', shown: true, inside: ['page'] }
  const page: Fake = { id: 'page', shown: true, inside: [] }
  expect(chooseZone([shell, page], shown, contains)).toBe(page)
})

test('chooseZone ignores zones of a hidden page, so its shell zone wins', () => {
  const shell: Fake = { id: 'shell', shown: true, inside: ['hidden'] }
  const hidden: Fake = { id: 'hidden', shown: false, inside: [] }
  expect(chooseZone([shell, hidden], shown, contains)).toBe(shell)
})

test('chooseZone returns null when every zone is hidden', () => {
  expect(chooseZone([{ id: 'a', shown: false, inside: [] }], shown, contains)).toBeNull()
})
