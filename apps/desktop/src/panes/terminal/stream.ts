/** Rendered bytes are acked once 64 KB pile up or after a 16 ms lull, far under the daemon's 1 MB lag mark */
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

/** Channel frame kinds, written by src-tauri/src/types.rs: [u8 kind][u64 LE seq][payload] */
export const FRAME = { snapshot: 0, data: 1, resync: 2 } as const
const FRAME_HEADER = 9

export function parseFrame(frame: ArrayBuffer): { kind: number; seq: number; bytes: Uint8Array } {
  const view = new DataView(frame)
  return { kind: view.getUint8(0), seq: Number(view.getBigUint64(1, true)), bytes: new Uint8Array(frame, FRAME_HEADER) }
}

/** Full reset (RIS) in band: unlike term.reset() it lands after the output still queued in xterm */
const RESET = new Uint8Array([0x1b, 0x63])

interface Writable {
  write(data: Uint8Array, callback?: () => void): void
}

/**
 * Writes one attachment into xterm in seq order. Output that comes before the snapshot waits for it; a resync (the
 * daemon skipped output this view fell behind on) resets the screen to its snapshot and continues from its seq.
 * `rendered` runs from xterm's write callback with the bytes to ack (snapshots are never acked) and the seq drawn to
 */
export function attachStream(term: Writable, rendered: (bytes: number, seq: number) => void) {
  let from = 0
  let early: [Uint8Array, number, boolean][] | null = []
  const write = (bytes: Uint8Array, seq: number, resync: boolean): void => {
    if (resync) {
      from = seq
      term.write(RESET)
      term.write(bytes, () => rendered(0, seq))
    } else {
      term.write(bytesFrom(bytes, seq, from), () => rendered(bytes.length, seq + bytes.length))
    }
  }
  return {
    /** The attach callback */
    onData(bytes: Uint8Array, seq: number, resync = false): void {
      if (early) early.push([bytes, seq, resync])
      else write(bytes, seq, resync)
    },
    /** The attach reply: its snapshot and the seq it ends at */
    snapshot(bytes: Uint8Array, seq: number): void {
      from = seq
      term.write(bytes, () => rendered(0, seq))
      for (const [b, s, r] of early ?? []) write(b, s, r)
      early = null
    }
  }
}
