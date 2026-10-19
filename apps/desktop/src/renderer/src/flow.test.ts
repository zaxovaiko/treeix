import { expect, test } from 'bun:test'
import { crossings, layered, prettify, untangle } from './flow'

const node = (id: string, y = 0): { id: string; position: { x: number; y: number } } => ({ id, position: { x: 0, y } })
const at = (nodes: ReturnType<typeof layered<ReturnType<typeof node>>>): Record<string, string> =>
  Object.fromEntries(nodes.map(({ id, position }) => [id, `${position.x},${position.y}`]))

test('layered puts a node one column after its deepest source and stacks by height', () => {
  const nodes = [node('a'), node('b', 1), node('c', 2), node('lone', 3)]
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'a', target: 'c' }
  ]
  expect(at(layered(nodes, edges, { column: 100, height: () => 50 }))).toEqual({ a: '0,0', b: '100,0', c: '200,0', lone: '0,50' })
})

test('untangle levels a node with the one it links to', () => {
  // a1 links to b2, a2 to b1: crossed until the second column swaps
  const nodes = [node('a1'), node('a2', 1), node('b1', 2), node('b2', 3)]
  const edges = [
    { source: 'a1', target: 'b2' },
    { source: 'a2', target: 'b1' }
  ]
  const result = at(untangle(layered(nodes, edges, { column: 100, height: () => 50 }), edges, () => 50))
  expect(result.a1.split(',')[1] === result.b2.split(',')[1] && result.a2.split(',')[1] === result.b1.split(',')[1]).toBe(true)
})

test('prettify wraps a tall column to fill a wide canvas', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => node(id, index))
  const result = prettify(nodes, [], { column: 100, height: () => 50, aspect: 2 })
  // 3 columns of 2 fit a 2:1 canvas best: 300 by 100
  expect(new Set(result.map((each) => each.position.x)).size).toBe(3)
  expect(Math.max(...result.map((each) => each.position.y))).toBe(50)
})

test('crossings counts lines that cross, not ones meeting at a node', () => {
  const at = { a: { x: 0, y: 0 }, b: { x: 0, y: 10 }, c: { x: 10, y: 0 }, d: { x: 10, y: 10 } }
  const point = (id: string): { x: number; y: number } | undefined => at[id as keyof typeof at]
  expect(
    crossings(
      [
        { source: 'a', target: 'd' },
        { source: 'b', target: 'c' }
      ],
      point
    )
  ).toBe(1)
  expect(
    crossings(
      [
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' }
      ],
      point
    )
  ).toBe(0)
  expect(
    crossings(
      [
        { source: 'a', target: 'd' },
        { source: 'a', target: 'c' }
      ],
      point
    )
  ).toBe(0)
})

test('vertical turns columns into centered rows; grid fills rows to suit the canvas', () => {
  const nodes = ['a', 'b', 'c'].map((id, index) => node(id, index))
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' }
  ]
  expect(at(prettify(nodes, edges, { column: 100, height: () => 50, aspect: 1, layout: 'vertical' }))).toEqual({ a: '50,0', b: '0,50', c: '100,50' })
  // 9 nodes on a 4:1 canvas: 5 per row (500 by 100) zooms in further than 3 per row (300 by 150) or one row (900 by 50)
  const many = Array.from({ length: 9 }, (_, index) => node(`n${index}`, index))
  const grid = prettify(many, [], { column: 100, height: () => 50, aspect: 4, layout: 'grid' })
  expect(new Set(grid.map((each) => each.position.y)).size).toBe(2)
})

test('hierarchy centers a node beside its subtree and hangs a shared node off one parent', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id, index) => node(id, index))
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'd' },
    { source: 'c', target: 'd' }
  ]
  expect(at(prettify(nodes, edges, { column: 100, height: () => 50, aspect: 1, layout: 'hierarchy' }))).toEqual({ a: '0,25', b: '100,0', c: '100,50', d: '200,0' })
})

test('circle rings the nodes with neighbours at least a column apart', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id, index) => node(id, index))
  const ring = prettify(nodes, [], { column: 100, height: () => 50, aspect: 1, layout: 'circle' }).map(({ position }) => position)
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)
  ring.forEach((point, index) => expect(distance(point, ring[(index + 1) % ring.length])).toBeCloseTo(100))
})

test('layered survives cycles and self edges', () => {
  const nodes = [node('a'), node('b', 1)]
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
    { source: 'a', target: 'a' }
  ]
  const result = at(layered(nodes, edges, { column: 10, height: () => 1 }))
  expect(new Set(Object.values(result)).size).toBe(2)
})
