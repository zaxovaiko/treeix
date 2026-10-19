import { expect, test } from 'bun:test'
import { fittingEdge, placePane, removePane } from './paneLayout'

test('placePane opens a column to the right or stacks under the target', () => {
  expect(placePane([['a']], 'b', 'a', 'right')).toEqual([['a'], ['b']])
  expect(placePane([['a'], ['c']], 'b', 'a', 'right')).toEqual([['a'], ['b'], ['c']])
  expect(placePane([['a', 'c']], 'b', 'a', 'bottom')).toEqual([['a', 'b', 'c']])
  expect(placePane([['a', 'b']], 'b', 'a', 'right')).toEqual([['a'], ['b']])
  expect(placePane([['a']], 'b', 'x', 'right')).toEqual([['a'], ['b']])
})

test('removePane drops empty columns', () => {
  expect(removePane([['a'], ['b', 'c']], 'a')).toEqual([['b', 'c']])
})

test('fittingEdge splits down when a narrow pane has no room to the right', () => {
  expect(fittingEdge({ width: 600, height: 400 }, 'right')).toBe('right')
  expect(fittingEdge({ width: 440, height: 400 }, 'right')).toBe('bottom')
  expect(fittingEdge({ width: 440, height: 200 }, 'right')).toBeNull()
  expect(fittingEdge({ width: 900, height: 200 }, 'bottom')).toBeNull()
})
