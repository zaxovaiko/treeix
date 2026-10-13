import { expect, test } from 'bun:test'
import { layered, untangle } from './flow'

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
