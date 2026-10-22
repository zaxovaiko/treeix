/** Rendered bytes are acked once 64 KB pile up or after a 16 ms lull, far under the daemon's 1 MB pause mark */
export const ACK_BYTES = 64 * 1024
export const ACK_IDLE_MS = 16

export interface AckBatcher {
  /** xterm finished rendering `bytes` more bytes */
  rendered(bytes: number): void
  /** Acks what is pending now and stops the timer */
  flush(): void
}

export function ackBatcher(send: (bytes: number) => void, maxBytes = ACK_BYTES, idleMs = ACK_IDLE_MS): AckBatcher {
  let pending = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending === 0) return
    const bytes = pending
    pending = 0
    send(bytes)
  }
  return {
    rendered(bytes) {
      pending += bytes
      if (pending >= maxBytes) flush()
      else timer ??= setTimeout(flush, idleMs)
    },
    flush
  }
}

/** The part of a chunk starting at `seq` that comes after `from`, the seq an attach snapshot already covers */
export function bytesFrom(bytes: Uint8Array, seq: number, from: number): Uint8Array {
  if (seq >= from) return bytes
  return bytes.subarray(Math.min(bytes.length, from - seq))
}
