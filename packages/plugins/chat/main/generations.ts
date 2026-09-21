/** Tracks the latest requested generation per key, so a slower earlier request can tell it was superseded */
export function createGenerationGuard<K>(): { begin: (key: K) => number; isCurrent: (key: K, token: number) => boolean } {
  const current = new Map<K, number>()

  const begin = (key: K): number => {
    const token = (current.get(key) ?? 0) + 1
    current.set(key, token)
    return token
  }

  const isCurrent = (key: K, token: number): boolean => current.get(key) === token

  return { begin, isCurrent }
}
