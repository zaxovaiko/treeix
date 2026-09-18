import { expect, test } from 'bun:test'
import { emptyHistory, recordPlace, stepPlace } from './navigationHistory'

test('navigation history goes back and forward like a browser', () => {
  const same = (a: string, b: string): boolean => a === b
  let history = ['a', 'b', 'b', 'c'].reduce((current, place) => recordPlace(current, place, same), emptyHistory<string>())
  expect(history.entries).toEqual(['a', 'b', 'c'])

  const back = stepPlace(history, -1)
  expect(back?.place).toBe('b')
  history = back!.history
  expect(stepPlace(history, 1)?.place).toBe('c')

  // Recording from the middle drops the forward entry
  history = recordPlace(history, 'd', same)
  expect(history.entries).toEqual(['a', 'b', 'd'])
  expect(stepPlace(history, 1)).toBeNull()
  expect(stepPlace(emptyHistory<string>(), -1)).toBeNull()
})
