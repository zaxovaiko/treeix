import { expect, test } from 'bun:test'
import { runSteps, scrollbackDiff, waitFor } from './run'

test('runSteps reports every step and keeps going after a failure', async () => {
  let clock = 0
  const order: string[] = []
  const report = await runSteps(
    [
      ['first', async () => void order.push('first')],
      ['broken', async () => {
        throw new Error('nope')
      }],
      ['thrown string', () => Promise.reject('plain')],
      ['last', async () => void order.push('last')],
    ],
    () => (clock += 5)
  )
  expect(order).toEqual(['first', 'last'])
  expect(report.passed).toEqual([
    { name: 'first', ms: 5 },
    { name: 'last', ms: 5 },
  ])
  expect(report.failed).toEqual([
    { name: 'broken', error: 'nope' },
    { name: 'thrown string', error: 'plain' },
  ])
})

test('waitFor resolves with the first truthy value', async () => {
  let calls = 0
  expect(await waitFor('three calls', () => (++calls >= 3 ? calls : null), 1000, 1)).toBe(3)
  expect(await waitFor('zero is a value', () => 0, 10)).toBe(0)
})

test('waitFor times out naming what it waited for and the last error', async () => {
  await expect(waitFor('never', () => false, 20, 5)).rejects.toThrow('timed out after 20 ms waiting for never')
  await expect(
    waitFor('throws', () => {
      throw new Error('boom')
    }, 20, 5)
  ).rejects.toThrow('waiting for throws: boom')
})

test('scrollbackDiff ignores blank lines and trailing spaces', () => {
  expect(scrollbackDiff(['$ echo hi', 'hi   ', '', '$ '], ['$ echo hi', 'hi', '$', '', ''])).toBeNull()
})

test('scrollbackDiff names the first line that differs', () => {
  expect(scrollbackDiff(['a', 'b'], ['a', 'c'])).toBe('line 1 of 2/2: "b" became "c"')
  expect(scrollbackDiff(['a', 'b'], ['a'])).toBe('line 1 of 2/1: "b" became null')
  expect(scrollbackDiff(['a'], ['a', 'extra'])).toBe('line 1 of 1/2: null became "extra"')
})
