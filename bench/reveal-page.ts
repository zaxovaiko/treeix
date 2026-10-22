// Browser half of reveal.mts: times the TerminalPane reveal path (fresh xterm + WebGL, attach, 5000-line snapshot, a frame)
// against an in-page attach, and xterm's parse + draw throughput on the bench files, so only the frontend cost is measured;
// the pty, ptyd and IPC come on top in the app
import type { Attachment, SessionInfo } from '../apps/next/src/ipc/api'
import { reveal, spread } from '../apps/next/src/panes/terminal/bench'
import { openXterm } from '../apps/next/src/panes/terminal/xterm'

let lines = ''
for (let i = 1; i <= 5000; i++) lines += `\x1b[3${(i % 7) + 1}mline ${String(i).padStart(4, '0')}\x1b[0m ${'scrollback text '.repeat(1 + (i % 6))}\r\n`
const snapshot = new TextEncoder().encode(lines)
const info: SessionInfo = {
  id: 'bench',
  kind: 'shell',
  cwd: '/',
  title: 'bench',
  status: 'running',
  pid: null,
  exitCode: null,
  cols: 120,
  rows: 40,
  createdAt: 0,
  command: [],
  seq: snapshot.length,
  agentSession: null,
  routine: null
}
const attach = async (): Promise<Attachment> => ({ snapshot, seq: snapshot.length, info, detach: async () => {} })

declare global {
  interface Window {
    revealResult?: unknown
  }
}
const total = await reveal({ attach }, 'bench', 40)
// The part an LRU of hidden instances would save: a fresh xterm + WebGL with nothing written, one frame
async function openOnly(webgl: boolean) {
  const open: number[] = []
  for (let i = 0; i < 40; i++) {
    const host = document.createElement('div')
    host.className = 'term'
    Object.assign(host.style, { position: 'fixed', inset: '0', width: '960px', height: '600px' })
    document.body.append(host)
    const t0 = performance.now()
    const view = openXterm(host, webgl)
    await new Promise((done) => requestAnimationFrame(done))
    open.push(performance.now() - t0)
    view.dispose()
    host.remove()
  }
  return spread(open)
}
// The pane's path without IPC: 64 KB frames like ptyd's, at most 1 MB unacked like its flow control, until all is drawn
async function throughput(file: string) {
  const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer())
  const host = document.createElement('div')
  host.className = 'term'
  Object.assign(host.style, { position: 'fixed', inset: '0', width: '960px', height: '600px' })
  document.body.append(host)
  const view = openXterm(host, true)
  let unacked = 0
  let wake: (() => void) | null = null
  const drained = (below: number) => new Promise<void>((done) => (wake = () => unacked <= below && ((wake = null), done())))
  const t0 = performance.now()
  for (let at = 0; at < bytes.length; at += 65536) {
    const chunk = bytes.subarray(at, at + 65536)
    unacked += chunk.length
    view.term.write(chunk, () => {
      unacked -= chunk.length
      wake?.()
    })
    if (unacked > 1 << 20) await drained(256 << 10)
  }
  if (unacked > 0) await drained(0)
  await new Promise((done) => requestAnimationFrame(done))
  const seconds = (performance.now() - t0) / 1000
  view.dispose()
  host.remove()
  return { file, mbPerSecond: Math.round((bytes.length / 1024 / 1024 / seconds) * 10) / 10 }
}

window.revealResult = {
  ...total,
  openWebgl: await openOnly(true),
  openDom: await openOnly(false),
  throughput: [await throughput('mixed-100m.ans'), await throughput('plain-50m.txt')]
}
