/** Coalesces pushes into one flush per delay window, so a burst of events crosses the IPC boundary once */
export function createBatcher<T>(flush: (items: T[]) => void, delayMs = 50): { push: (item: T) => void; dispose: () => void } {
  let queue: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const push = (item: T): void => {
    queue.push(item)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const batch = queue
      queue = []
      flush(batch)
    }, delayMs)
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    queue = []
  }

  return { push, dispose }
}
