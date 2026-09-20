import { expect, test } from 'bun:test'
import { coalesceOutput } from './coalesce'

test('joins chunks per session and sends them once after the delay', async () => {
  const sent: [string, string][] = []
  const output = coalesceOutput((id, data) => sent.push([id, data]), 5)
  output.push('a', 'he')
  output.push('b', 'x')
  output.push('a', 'llo')
  expect(sent).toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(sent).toEqual([
    ['a', 'hello'],
    ['b', 'x']
  ])
})

test('flush sends right away and drop forgets', async () => {
  const sent: [string, string][] = []
  const output = coalesceOutput((id, data) => sent.push([id, data]), 5)
  output.push('a', 'bye')
  output.flush('a')
  output.push('b', 'stale')
  output.drop('b')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(sent).toEqual([['a', 'bye']])
})
