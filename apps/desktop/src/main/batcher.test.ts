import { describe, expect, mock, test } from 'bun:test'
import { createBatcher } from './batcher'

describe('createBatcher', () => {
  test('coalesces pushes within the delay into one flush', async () => {
    const flush = mock((_items: number[]) => undefined)
    const batcher = createBatcher(flush, 10)
    batcher.push(1)
    batcher.push(2)
    batcher.push(3)
    expect(flush).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([1, 2, 3])
  })

  test('starts a fresh batch after each flush', async () => {
    const flush = mock((_items: number[]) => undefined)
    const batcher = createBatcher(flush, 10)
    batcher.push(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    batcher.push(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenNthCalledWith(1, [1])
    expect(flush).toHaveBeenNthCalledWith(2, [2])
  })

  test('dispose cancels a pending flush', async () => {
    const flush = mock((_items: number[]) => undefined)
    const batcher = createBatcher(flush, 10)
    batcher.push(1)
    batcher.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('createBatcher flush', () => {
  test('sends what is queued at once and cancels the pending timer', async () => {
    const flush = mock((_items: number[]) => undefined)
    const batcher = createBatcher(flush, 10)
    batcher.push(1)
    batcher.push(2)
    batcher.flush()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([1, 2])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('does nothing when nothing is queued', () => {
    const flush = mock((_items: number[]) => undefined)
    createBatcher(flush, 10).flush()
    expect(flush).not.toHaveBeenCalled()
  })
})
