import { expect, test } from 'bun:test'
import { addPane, edgeAt, neighborPane, placePane, removePane, remapPanes } from './paneLayout'

test('addPane opens columns, then stacks into the shortest one', () => {
  let layout = addPane([], 'a')
  layout = addPane(layout, 'b')
  layout = addPane(layout, 'c')
  expect(layout).toEqual([['a'], ['b'], ['c']])
  expect(addPane(layout, 'd')).toEqual([['a', 'd'], ['b'], ['c']])
  expect(addPane(layout, 'a')).toBe(layout)
})

test('placePane splits columns or stacks rows', () => {
  const layout = [['a'], ['b']]
  expect(placePane(layout, 'b', 'a', 'bottom')).toEqual([['a', 'b']])
  expect(placePane(layout, 'b', 'a', 'top')).toEqual([['b', 'a']])
  expect(placePane(layout, 'b', 'a', 'left')).toEqual([['b'], ['a']])
  expect(placePane([['a', 'b']], 'b', 'a', 'right')).toEqual([['a'], ['b']])
  expect(placePane(layout, 'c', 'a', 'bottom')).toEqual([['a', 'c'], ['b']])
  expect(placePane(layout, 'a', 'a', 'top')).toBe(layout)
})

test('removePane drops empty columns', () => {
  expect(removePane([['a'], ['b', 'c']], 'a')).toEqual([['b', 'c']])
})

test('edgeAt picks the closest side', () => {
  expect(edgeAt(5, 50, 100, 100, true)).toBe('left')
  expect(edgeAt(95, 50, 100, 100, true)).toBe('right')
  expect(edgeAt(50, 90, 100, 100, true)).toBe('bottom')
  expect(edgeAt(5, 40, 100, 100, false)).toBe('top')
})

test('remapPanes renames panes and drops missing ones with their empty columns', () => {
  expect(remapPanes([['a', 'b'], ['c']], (id) => ({ a: 'x', c: undefined, b: 'y' })[id])).toEqual([['x', 'y']])
})

test('neighborPane walks rows within a column and columns at the same height', () => {
  const layout = [['a', 'b'], ['c'], ['d', 'e', 'f']]
  expect(neighborPane(layout, 'a', 'bottom')).toBe('b')
  expect(neighborPane(layout, 'a', 'top')).toBeNull()
  expect(neighborPane(layout, 'b', 'right')).toBe('c')
  expect(neighborPane(layout, 'c', 'right')).toBe('e')
  expect(neighborPane(layout, 'f', 'left')).toBe('c')
  expect(neighborPane(layout, 'a', 'left')).toBeNull()
})
