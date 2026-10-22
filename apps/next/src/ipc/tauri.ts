import { Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Api, Attachment, SessionEvent } from './api'
import { commands, type Frame } from './bindings'

// Channel frame layout, written by src-tauri/src/types.rs: [u8 kind][u64 LE seq][payload]
const SNAPSHOT = 0
const HEADER = 9

const done = (call: Promise<unknown>): Promise<void> => call.then(() => undefined)

async function attach(id: string, onData: (bytes: Uint8Array, seq: number) => void): Promise<Attachment> {
  let resolveSnapshot: (bytes: Uint8Array) => void = () => {}
  const snapshot = new Promise<Uint8Array>((resolve) => (resolveSnapshot = resolve))
  const channel = new Channel<Frame>()
  channel.onmessage = (message) => {
    // Raw channel bodies arrive as an ArrayBuffer, not the number[] specta derives for Frame
    const frame = message as unknown as ArrayBuffer
    const view = new DataView(frame)
    const bytes = new Uint8Array(frame, HEADER)
    if (view.getUint8(0) === SNAPSHOT) resolveSnapshot(bytes)
    else onData(bytes, Number(view.getBigUint64(1, true)))
  }
  // The snapshot is sent before the reply, and channel messages keep their order, so data never precedes it
  const { seq, info } = await commands.attach(id, channel)
  return { snapshot: await snapshot, seq, info, detach: () => done(commands.detach(id, channel.id)) }
}

export function tauriApi(): Api {
  return {
    hello: commands.hello,
    sessions: commands.sessions,
    create: (opts) =>
      commands.create({
        kind: opts.kind,
        cwd: opts.cwd ?? null,
        command: opts.command,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows,
        title: opts.title ?? null,
        routine: opts.routine ?? null,
      }),
    attach,
    write: (id, data) => done(typeof data === 'string' ? commands.write(id, data) : commands.writeBytes(id, Array.from(data))),
    resize: (id, cols, rows) => done(commands.resize(id, cols, rows)),
    ack: (id, bytes) => done(commands.ack(id, bytes)),
    kill: (id) => done(commands.kill(id)),
    remove: (id) => done(commands.remove(id)),
    restart: (id) => done(commands.restart(id)),
    clear: (id) => done(commands.clear(id)),
    getUi: commands.getUi,
    putUi: (json) => done(commands.putUi(json)),
    places: commands.places,
    homeDir: commands.homeDir,
    onEvent(cb) {
      const unlisten = listen<SessionEvent>('session-event', (event) => cb(event.payload))
      return () => void unlisten.then((stop) => stop())
    },
  }
}
