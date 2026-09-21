import { describe, expect, test } from 'bun:test'
import { createGenerationGuard } from './generations'

describe('createGenerationGuard', () => {
  test('the latest token for a key is current, earlier ones are not', () => {
    const guard = createGenerationGuard<string>()
    const first = guard.begin('a')
    const second = guard.begin('a')
    expect(guard.isCurrent('a', first)).toBe(false)
    expect(guard.isCurrent('a', second)).toBe(true)
  })

  test('keys are independent', () => {
    const guard = createGenerationGuard<string>()
    const a = guard.begin('a')
    const b = guard.begin('b')
    expect(guard.isCurrent('a', a)).toBe(true)
    expect(guard.isCurrent('b', b)).toBe(true)
  })

  test('a key with no started generation is never current', () => {
    const guard = createGenerationGuard<string>()
    expect(guard.isCurrent('a', 1)).toBe(false)
  })
})
