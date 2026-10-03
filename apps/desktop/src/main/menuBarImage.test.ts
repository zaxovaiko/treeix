import { expect, test } from 'bun:test'
import { HEIGHT, menuBarAlpha } from './menuBarImage'

test('rings fill clockwise from the top by the share used, the rest shows as a faint track', () => {
  const glyph = { width: 2, alpha: new Uint8Array(2 * HEIGHT).fill(255) }
  const { width, alpha } = menuBarAlpha(glyph, [[0.25, null]])
  const at = (x: number, y: number): number => alpha[y * width + x]
  expect(at(0, 0)).toBe(255)
  // Outer ring, centre at x 2 + 8 + 15 = 25, radius 13: right side is a quarter round, left is past it
  expect(at(25 + 13, 17)).toBeGreaterThan(200)
  expect(at(25 - 14, 18)).toBeLessThan(100)
  expect(at(25 - 14, 18)).toBeGreaterThan(0)
  // The inner ring has no number, so only its track
  expect(at(25 + 7, 18)).toBeLessThan(100)
})
