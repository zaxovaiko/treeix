// In-app terminal bench, Phase 0 gate: `TREEIX_AUTORUN=bench` (src/autorun.ts), or `await __treeixBench()` in a dev build's console.
// Inputs come from `bun bench/gen.ts`, see bench/README.md
import type { Terminal } from '@xterm/xterm'
import { api as defaultApi, type Api } from '../../ipc/api'
import { ackBatcher, bytesFrom } from './stream'
import { openXterm } from './xterm'

const DIR = '/tmp/treeix-bench'
const THROUGHPUT_FILES = [`${DIR}/mixed-100m.ans`, `${DIR}/plain-50m.txt`]
const ECHO_SAMPLES = 300
const ECHO_WARMUP = 10
const REVEAL_SAMPLES = 30
const DONE_TITLE = 'treeix-bench-done'

export interface Spread {
  samples: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface BenchResult {
  at: string
  userAgent: string
  throughput: { file: string; bytes: number; seconds: number; mbPerSecond: number }[]
  /** Write of one char until xterm has drawn its echo, ms */
  keyToEcho: Spread
  /** Attach + 5000-line snapshot written + a frame, ms */
  reveal: Spread
}

const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()))
const written = (term: Terminal, data: string | Uint8Array): Promise<void> => new Promise((done) => term.write(data, done))
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  const round = (n: number): number => Math.round(n * 100) / 100
  return { samples: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1) ?? 0) }
}

/** A visible pane-sized host on top of the app, so WebGL really draws */
function stage(): HTMLElement {
  const host = document.createElement('div')
  host.className = 'term'
  Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '960px', height: '600px', zIndex: '9999' })
  document.body.append(host)
  return host
}

/** Resolves when the session sets its title to `title` */
function titled(api: Api, id: string, title: string): Promise<void> {
  return new Promise((done) => {
    const stop = api.onEvent((event) => {
      if (event.type === 'title' && event.session === id && event.title === title) {
        stop()
        done()
      }
    })
  })
}

/** A session on screen like a TerminalPane, with seq tracking so the bench knows when every byte has been drawn */
async function attachStaged(api: Api, id: string) {
  const host = stage()
  const view = openXterm(host, true)
  const acks = ackBatcher((bytes) => void api.ack(id, bytes))
  let end = 0
  let from = 0
  let waiter: { until: number; done: () => void } | null = null
  const attachment = await api.attach(id, (bytes, seq) => {
    view.term.write(bytesFrom(bytes, seq, from), () => {
      acks.rendered(bytes.length)
      end = Math.max(end, seq + bytes.length)
      if (waiter && end >= waiter.until) waiter.done()
    })
  })
  from = end = attachment.seq
  await written(view.term, attachment.snapshot)
  return {
    view,
    /** Seq up to which output has been written to xterm */
    seen: (): number => end,
    /** Resolves once output up to `seq` has been written to xterm */
    drawnTo: (seq: number): Promise<void> => (end >= seq ? Promise.resolve() : new Promise((done) => (waiter = { until: seq, done }))),
    async close() {
      acks.flush()
      await attachment.detach()
      view.dispose()
      host.remove()
      await api.kill(id).catch(() => {})
      await api.remove(id).catch(() => {})
    }
  }
}

async function finalSeq(api: Api, id: string): Promise<number> {
  return (await api.sessions()).find((session) => session.id === id)?.seq ?? 0
}

/** `cat` of a file: from the start signal until its end marker (an OSC title) is drawn */
async function throughput(api: Api, file: string) {
  // No echo and no \n -> \r\n, so the bytes drawn are the file's; cat waits for the start signal.
  // It stays alive after: the shell removes a shell session that exits cleanly, and with it the final seq
  const command = ['/bin/sh', '-c', `stty -echo -onlcr; read _; cat "$0"; printf '\\033]2;${DONE_TITLE}\\007'; exec sleep 86400`, file]
  const session = await api.create({ kind: 'shell', command, cols: 120, rows: 40 })
  const done = titled(api, session.id, DONE_TITLE)
  const staged = await attachStaged(api, session.id)
  await sleep(300)
  const start = await finalSeq(api, session.id)
  const t0 = performance.now()
  await api.write(session.id, '\n')
  await done
  const end = await finalSeq(api, session.id)
  await staged.drawnTo(end)
  await frame()
  const seconds = (performance.now() - t0) / 1000
  await staged.close()
  const bytes = end - start
  return { file, bytes, seconds: Math.round(seconds * 1000) / 1000, mbPerSecond: Math.round((bytes / 1024 / 1024 / seconds) * 10) / 10 }
}

/** The tty echoes each char of a plain `cat` at once; timed until xterm drew it and a frame passed */
async function keyToEcho(api: Api): Promise<Spread> {
  const session = await api.create({ kind: 'shell', command: ['cat'], cols: 120, rows: 40 })
  const staged = await attachStaged(api, session.id)
  await sleep(300)
  const samples: number[] = []
  for (let i = 0; i < ECHO_SAMPLES + ECHO_WARMUP; i++) {
    // Short lines: a canonical-mode line caps at 1024 bytes
    if (i % 60 === 59) {
      await api.write(session.id, '\r')
      await sleep(50)
    }
    const seq = staged.seen()
    const t0 = performance.now()
    await api.write(session.id, String.fromCharCode(97 + (i % 26)))
    await staged.drawnTo(seq + 1)
    await frame()
    if (i >= ECHO_WARMUP) samples.push(performance.now() - t0)
    await sleep(5)
  }
  await staged.close()
  return spread(samples)
}

/** Reveal of a session holding 5000 lines of scrollback: a fresh xterm (WebGL), attach, snapshot written, one frame */
export async function reveal(api: Pick<Api, 'attach'>, id: string, samples = REVEAL_SAMPLES): Promise<Spread> {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    const host = stage()
    const view = openXterm(host, true)
    const attachment = await api.attach(id, () => {})
    await written(view.term, attachment.snapshot)
    await frame()
    times.push(performance.now() - t0)
    await attachment.detach()
    view.dispose()
    host.remove()
    await sleep(20)
  }
  return spread(times)
}

async function revealBench(api: Api): Promise<Spread> {
  const session = await api.create({ kind: 'shell', command: ['/bin/sh', '-c', 'cat "$0"; exec sleep 86400', `${DIR}/scroll-5k.ans`], cols: 120, rows: 40 })
  // Settled once the output stops growing
  for (let last = -1, seq = 0; seq !== last; seq = await finalSeq(api, session.id)) {
    last = seq
    await sleep(300)
  }
  const result = await reveal(api, session.id)
  await api.kill(session.id)
  await api.remove(session.id).catch(() => {})
  return result
}

export async function runBench(api: Api): Promise<BenchResult> {
  const result: BenchResult = {
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    throughput: [],
    keyToEcho: await keyToEcho(api),
    reveal: await revealBench(api)
  }
  for (const file of THROUGHPUT_FILES) result.throughput.push(await throughput(api, file))
  console.log(JSON.stringify(result, null, 2))
  return result
}

declare global {
  interface Window {
    __treeixBench?: (api?: Api) => Promise<BenchResult>
  }
}

window.__treeixBench = async (api) => runBench(api ?? (await defaultApi()))
