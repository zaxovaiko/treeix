/** Output flushed per session in one IPC message: a busy program writes many tiny chunks, each of which was its own send */
export type OutputCoalescer = {
  push: (id: string, data: string) => void
  /** Sends what the session has pending now, e.g. before its exit is reported */
  flush: (id: string) => void
  /** Forgets what the session has pending, e.g. when a reload already got it with the scrollback */
  drop: (id: string) => void
}

export function coalesceOutput(send: (id: string, data: string) => void, delayMs = 8): OutputCoalescer {
  const pending = new Map<string, string[]>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (id: string): void => {
    const chunks = pending.get(id)
    pending.delete(id)
    if (chunks) send(id, chunks.join(''))
  }
  const flushAll = (): void => {
    timer = null
    for (const id of [...pending.keys()]) flush(id)
  }
  return {
    push: (id, data) => {
      const chunks = pending.get(id)
      if (chunks) chunks.push(data)
      else pending.set(id, [data])
      timer ??= setTimeout(flushAll, delayMs)
    },
    flush,
    drop: (id) => void pending.delete(id)
  }
}
