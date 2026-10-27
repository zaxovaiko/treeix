// In-app e2e, `TREEIX_AUTORUN=e2e` (src/autorun.ts): drives the real UI against the real daemon. Panes are found by
// their stable class names and button titles; what a pane shows is read by tapping `api.attach`, the one way bytes
// reach a TerminalPane, and replaying them into an off-screen xterm. e2e/inapp.spec.ts runs it headless on the mock
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Api, Attachment, SessionInfo } from '../ipc/api'
import { chordOf, keyFor, type ActionId } from '../lib/hotkeys'
import { bytesFrom } from '../panes/terminal/stream'
import { runSteps, scrollbackDiff, waitFor, type E2eReport, type Step } from './run'

/** Phase 1 exit: quit and reopen with 20 sessions reattaches them in under this */
const REATTACH_BUDGET_MS = 300
const REATTACH_SESSIONS = 20
/** A fresh login shell can take a while to print its prompt */
const SHELL_START_MS = 15_000

/** What the panes were sent on their latest attach */
interface Tapped {
  snapshot: Uint8Array
  seq: number
  /** A resync frame replaces the screen with the snapshot it carries */
  frames: [bytes: Uint8Array, seq: number, resync: boolean][]
  /** The pane's size at attach, then each resize it asked for and how many frames had arrived by then */
  cols: number
  rows: number
  resizes: [frames: number, cols: number, rows: number][]
  attaches: number
  attached: boolean
}

/** Wraps `api.attach` and `api.resize` in place (the shell holds this same object) and records what each pane receives */
function tap(api: Api) {
  const original = api.attach
  const resize = api.resize
  const panes = new Map<string, Tapped>()
  api.resize = (id, cols, rows) => {
    const pane = panes.get(id)
    if (pane?.attached) pane.resizes.push([pane.frames.length, cols, rows])
    return resize(id, cols, rows)
  }
  api.attach = async (id, onData): Promise<Attachment> => {
    const frames: Tapped['frames'] = []
    const attachment = await original(id, (bytes, seq, resync) => {
      frames.push([bytes, seq, !!resync])
      onData(bytes, seq, resync)
    })
    const { cols, rows } = attachment.info
    const tapped = { snapshot: attachment.snapshot, seq: attachment.seq, frames, cols, rows, resizes: [], attaches: (panes.get(id)?.attaches ?? 0) + 1, attached: true }
    panes.set(id, tapped)
    return {
      ...attachment,
      detach: () => {
        tapped.attached = false
        return attachment.detach()
      },
    }
  }
  return {
    panes,
    attach: original,
    untap: () => {
      api.attach = original
      api.resize = resize
    },
  }
}

const write = (term: Terminal, chunk: Uint8Array) => new Promise<void>((done) => term.write(chunk, done))

/** The text a pane shows (screen and scrollback), rendered the way TerminalPane writes and resizes it */
async function render(pane: Tapped): Promise<string[]> {
  const term = new Terminal({ cols: pane.cols, rows: pane.rows, scrollback: 5000, allowProposedApi: true })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  await write(term, pane.snapshot)
  const resizeAt = (frame: number) => pane.resizes.filter(([at]) => at === frame).forEach(([, cols, rows]) => term.resize(cols, rows))
  let from = pane.seq
  for (const [i, [bytes, seq, resync]] of pane.frames.entries()) {
    resizeAt(i)
    if (resync) {
      term.reset()
      from = seq
    }
    await write(term, resync ? bytes : bytesFrom(bytes, seq, from))
  }
  resizeAt(pane.frames.length)
  const buffer = term.buffer.active
  const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
  term.dispose()
  return lines
}

const visibleTerms = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.stage:not([hidden]) .panes:not([hidden]) .term[data-session-id]')]
const visibleIds = (): string[] => visibleTerms().map((el) => el.dataset.sessionId ?? '')
const paneOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.stage:not([hidden]) .term[data-session-id="${CSS.escape(id)}"]`)?.closest('.pane') ?? null

function button(title: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>(`button[title^="${title}"]`)].find((el) => el.offsetParent !== null)
  if (!found) throw new Error(`no visible "${title}" button`)
  return found
}

/** An app shortcut's default chord, as the keyboard would send it */
function press(id: ActionId) {
  const accel = keyFor(id, {})
  if (!accel) throw new Error(`no chord for ${id}`)
  ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { ...chordOf(accel), bubbles: true, cancelable: true }))
}

/** Text into the pane's xterm input, as a keyboard or IME would put it there */
function type(id: string, text: string) {
  const input = paneOf(id)?.querySelector('textarea')
  if (!input) throw new Error(`no input in pane ${id}`)
  input.focus()
  input.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true }))
}

/** Cmd+Option+arrow on macOS; Linux has no chord for it, so a click on the pane's header */
function moveFocus(arrow: 'ArrowLeft' | 'ArrowRight', to: string) {
  if (/Mac/.test(navigator.userAgent)) {
    const init = { key: arrow, code: arrow, metaKey: true, altKey: true, bubbles: true, cancelable: true }
    ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', init))
  } else paneOf(to)?.querySelector('.phd')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

export async function runE2e(api: Api): Promise<E2eReport> {
  const before = new Set((await api.sessions()).map((s) => s.id))
  const taps = tap(api)
  const info = async (id: string): Promise<SessionInfo> => {
    const found = (await api.sessions()).find((s) => s.id === id)
    if (!found) throw new Error(`session ${id} is gone`)
    return found
  }
  const paneText = async (id: string): Promise<string[]> => {
    const pane = taps.panes.get(id)
    if (!pane?.attached) throw new Error(`pane ${id} is not attached`)
    return render(pane)
  }
  let shell = ''
  let right = ''

  const steps: Step[] = [
    [
      'new shell opens in its own tab',
      async () => {
        const welcome = [...document.querySelectorAll<HTMLButtonElement>('.welcome button')].find((el) => /shell/i.test(el.textContent ?? ''))
        ;(welcome ?? button('New shell')).click()
        shell = await waitFor('a new pane', () => {
          const ids = visibleIds()
          return ids.length === 1 && !before.has(ids[0]) && ids[0]
        })
      },
    ],
    [
      'echo shows its output in the pane',
      async () => {
        await waitFor('the pane to attach', () => taps.panes.get(shell)?.attached)
        const marker = `treeix-e2e-${Date.now().toString(36)}`
        // The shell's prompt first, so the line isn't eaten by a starting zsh
        await waitFor('the prompt', async () => (await paneText(shell)).some((line) => line.trim()), SHELL_START_MS, 100)
        type(shell, `echo ${marker}\r`)
        await waitFor(`"${marker}" printed`, async () => (await paneText(shell)).some((line) => line.trimEnd() === marker), 5000, 100)
      },
    ],
    [
      'split right and down',
      async () => {
        button('Split right').click()
        right = await waitFor('a pane on the right', () => visibleIds().length === 2 && visibleIds().find((id) => id !== shell))
        button('Split down', paneOf(right) ?? undefined).click()
        const down = await waitFor('a pane below', () => visibleIds().length === 3 && visibleIds().find((id) => id !== shell && id !== right))
        const [a, b, c] = [shell, right, down].map((id) => paneOf(id)?.getBoundingClientRect())
        if (!a || !b || !c) throw new Error('a pane has no box')
        if (!(b.left >= a.right - 1 && c.top >= b.bottom - 1 && Math.abs(c.left - b.left) < 1)) throw new Error(`unexpected layout: ${JSON.stringify([a, b, c])}`)
      },
    ],
    [
      'focus moves between panes',
      async () => {
        moveFocus('ArrowLeft', shell)
        await waitFor('the left pane focused', () => paneOf(shell)?.classList.contains('focus'))
        moveFocus('ArrowRight', right)
        await waitFor('the right pane focused', () => paneOf(right)?.classList.contains('focus'))
      },
    ],
    [
      'close pane kills and forgets its session',
      async () => {
        const down = visibleIds().find((id) => id !== shell && id !== right)
        const pane = down && paneOf(down)
        if (!down || !pane) throw new Error('no third pane')
        button('Close pane', pane).click()
        await waitFor('two panes', () => visibleIds().length === 2)
        await waitFor('the session removed', async () => !(await api.sessions()).some((s) => s.id === down))
      },
    ],
    [
      'killed shell stays as exited',
      async () => {
        await api.kill(right)
        await waitFor('status exited', async () => (await info(right)).status === 'exited')
        await waitFor('the pane marked exited', () => paneOf(right)?.querySelector('.phd .st-exit'))
      },
    ],
    [
      'restart runs it again in place',
      async () => {
        const lines = async () => (await paneText(right)).filter((line) => line.trim()).length
        const exited = await lines()
        await api.restart(right)
        await waitFor('status back from exited', async () => (await info(right)).status !== 'exited')
        await waitFor('the exited mark gone', () => !paneOf(right)?.querySelector('.phd .st-exit'))
        // The old screen stays above the new shell's prompt
        await waitFor('the new prompt', async () => (await lines()) > exited, SHELL_START_MS, 100)
        if (!visibleIds().includes(right)) throw new Error('the pane moved')
      },
    ],
    [
      'detach and re-attach every pane keeps the scrollback',
      async () => {
        const ids = visibleIds()
        const shown = await Promise.all(ids.map(async (id) => ({ id, attaches: taps.panes.get(id)?.attaches ?? 0, text: await paneText(id) })))
        // Settings opens as its own tab, which hides this one: every pane detaches, and closing it brings them back
        press('settings')
        await waitFor('every pane detached', () => ids.every((id) => !taps.panes.get(id)?.attached))
        press('close-pane')
        await waitFor('every pane re-attached', () => shown.every(({ id, attaches }) => (taps.panes.get(id)?.attaches ?? 0) > attaches && taps.panes.get(id)?.attached))
        for (const { id, text } of shown) {
          const diff = scrollbackDiff(text, await paneText(id))
          if (diff) throw new Error(`pane ${id}: ${diff}`)
        }
      },
    ],
    [
      `${REATTACH_SESSIONS} sessions re-attach in under ${REATTACH_BUDGET_MS} ms`,
      async () => {
        const created = await Promise.all(Array.from({ length: REATTACH_SESSIONS }, () => api.create({ kind: 'shell', cols: 100, rows: 30 })))
        try {
          const markers = created.map((_, i) => `treeix-e2e-reattach-${i}`)
          // Typed once each shell has drawn its prompt (its seq moved), so every one has scrollback to send
          await waitFor('every shell started', async () => (await api.sessions()).filter((s) => created.some((c) => c.id === s.id) && s.seq > 0).length === created.length, SHELL_START_MS, 100)
          await Promise.all(created.map((s, i) => api.write(s.id, `echo ${markers[i]}\r`)))
          const decoder = new TextDecoder()
          const snapshotOf = async (id: string) => {
            const attachment = await taps.attach(id, () => {})
            await attachment.detach()
            return decoder.decode(attachment.snapshot)
          }
          await waitFor('every echo printed', async () => (await Promise.all(created.map((s) => snapshotOf(s.id)))).every((text, i) => text.split(markers[i]).length > 2), 5000, 100)

          const started = performance.now()
          const listed = (await api.sessions()).filter((s) => created.some((c) => c.id === s.id))
          const attachments = await Promise.all(listed.map((s) => taps.attach(s.id, () => {})))
          const ms = performance.now() - started
          await Promise.all(attachments.map((a) => a.detach()))
          const missing = attachments.filter((a) => !decoder.decode(a.snapshot).includes(markers[created.findIndex((c) => c.id === a.info.id)]))
          if (listed.length !== REATTACH_SESSIONS || missing.length) throw new Error(`${listed.length} listed, ${missing.length} snapshots without their output`)
          if (ms >= REATTACH_BUDGET_MS) throw new Error(`took ${Math.round(ms)} ms`)
        } finally {
          await Promise.all(created.map((s) => api.kill(s.id).then(() => api.remove(s.id)).catch(() => {})))
        }
      },
    ],
  ]

  try {
    return await runSteps(steps)
  } finally {
    taps.untap()
    // Leaves the daemon as it found it
    const leftover = (await api.sessions()).filter((s) => !before.has(s.id))
    await Promise.all(leftover.map((s) => api.kill(s.id).then(() => api.remove(s.id)).catch(() => {})))
  }
}
