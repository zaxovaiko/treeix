/** Coalesces pushes into one flush per delay window, so a burst of events crosses the IPC boundary once */
export function createBatcher<T>(send: (items: T[]) => void, delayMs = 50): { push: (item: T) => void; flush: () => void; dispose: () => void } {
  let queue: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const push = (item: T): void => {
    queue.push(item)
    if (timer) return
    timer = setTimeout(flush, delayMs)
  }

  /** Sends what is queued now, e.g. the last output before a disconnect */
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (queue.length === 0) return
    const batch = queue
    queue = []
    send(batch)
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    queue = []
  }

  return { push, flush, dispose }
}
