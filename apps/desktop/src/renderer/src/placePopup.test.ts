import { expect, test } from 'bun:test'
import { placePopup } from './ui'

const viewport = { width: 900, height: 700 }
const size = { width: 256, height: 300 }

test('opens below when it fits', () => {
  expect(placePopup({ left: 100, right: 200, top: 100, bottom: 120 }, size, viewport, 'start', null)).toEqual({ side: 'below', left: 100, top: 124, bottom: null, maxHeight: 568 })
})

test('flips above near the bottom and caps to the room there', () => {
  const spot = placePopup({ left: 100, right: 200, top: 600, bottom: 620 }, size, viewport, 'start', null)
  expect(spot).toMatchObject({ side: 'above', top: null, bottom: 104, maxHeight: 588 })
})

test('keeps its side while it still fits, even if the other side is roomier', () => {
  expect(placePopup({ left: 100, right: 200, top: 500, bottom: 520 }, { width: 256, height: 100 }, viewport, 'start', 'below').side).toBe('below')
  expect(placePopup({ left: 100, right: 200, top: 500, bottom: 520 }, size, viewport, 'start', 'below').side).toBe('above')
})

test('stays 8px inside both window edges', () => {
  expect(placePopup({ left: 850, right: 880, top: 10, bottom: 30 }, size, viewport, 'start', null).left).toBe(900 - 8 - 256)
  expect(placePopup({ left: 2, right: 40, top: 10, bottom: 30 }, size, viewport, 'end', null).left).toBe(8)
  expect(placePopup({ left: 500, right: 700, top: 10, bottom: 30 }, size, viewport, 'end', null).left).toBe(444)
})
