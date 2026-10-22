import { expect, test } from 'bun:test'
import { MAX_WEBGL_LOSSES, wantsWebgl } from './renderer'

test('auto is WebGL on macOS and DOM on Linux', () => {
  expect(wantsWebgl('auto', false, 0)).toBe(true)
  expect(wantsWebgl('auto', true, 0)).toBe(false)
  expect(wantsWebgl('webgl', true, 0)).toBe(true)
  expect(wantsWebgl('dom', false, 0)).toBe(false)
})

test('gives up on WebGL after repeated context losses', () => {
  expect(wantsWebgl('webgl', false, MAX_WEBGL_LOSSES - 1)).toBe(true)
  expect(wantsWebgl('webgl', false, MAX_WEBGL_LOSSES)).toBe(false)
  expect(wantsWebgl('auto', false, MAX_WEBGL_LOSSES)).toBe(false)
})
