import type { Api, Attachment, CreateSession, Place, PlaceKind, SessionEvent, SessionInfo, SessionStatus } from './api'

// In-browser fake daemon for the dev server and visual checks: a tiny shell over a fake file tree.
// `?seed=empty` starts with no sessions (first run); `window.treeixMock.restart()` simulates a daemon restart

const HOME = '/Users/me'
const TREEIX = `${HOME}/projects/treeix`
const UI_KEY = 'treeix-next-ui'

interface Checkout {
  path: string
  kind: PlaceKind
  repoRoot: string
  repoName: string
  branch: string | null
  head: string | null
}

const repo = (path: string, kind: PlaceKind, branch: string | null, head: string | null = null, repoRoot = TREEIX, repoName = 'treeix'): Checkout => ({
  path,
  kind,
  repoRoot,
  repoName,
  branch,
  head,
})

const CHECKOUTS: Checkout[] = [
  repo(TREEIX, 'root', 'main'),
  repo(`${TREEIX}/.worktrees/feat-terminal-redo`, 'worktree', 'feat/terminal-redo'),
  repo(`${TREEIX}/.worktrees/fix-pty-leak`, 'worktree', 'fix/pty-leak'),
  repo(`${TREEIX}/.worktrees/pr-405`, 'detached', null, '7d2c9e1'),
  repo(`${HOME}/dotfiles`, 'git', 'main', null, `${HOME}/dotfiles`, 'dotfiles'),
]

const REPO_FILES = ['apps/', 'crates/', 'packages/', 'docs/', 'Cargo.toml', 'package.json', 'README.md', 'bun.lock']
const FS: Record<string, string[]> = {
  [HOME]: ['projects/', 'dotfiles/', 'Downloads/', 'Desktop/', 'notes.md'],
  [`${HOME}/projects`]: ['treeix/', 'landing/'],
  [`${HOME}/projects/landing`]: ['index.html', 'styles.css', 'README.md'],
  [TREEIX]: [...REPO_FILES, '.worktrees/'],
  [`${TREEIX}/.worktrees`]: ['feat-terminal-redo/', 'fix-pty-leak/', 'pr-405/'],
  [`${TREEIX}/apps`]: ['desktop/', 'next/'],
  [`${TREEIX}/apps/next`]: ['src/', 'src-tauri/', 'package.json', 'vite.config.ts'],
  [`${TREEIX}/packages`]: ['ui/', 'plugins/'],
  [`${TREEIX}/packages/ui`]: ['src/', 'package.json'],
  [`${HOME}/dotfiles`]: ['.zshrc', '.gitconfig', 'install.sh'],
  [`${HOME}/Downloads`]: ['invoices/', 'report.pdf', 'IMG_2041.heic'],
  [`${HOME}/Downloads/invoices`]: ['2026-09.pdf', '2026-10.pdf'],
  [`${HOME}/Desktop`]: ['receipts/'],
}
for (const c of CHECKOUTS) if (c.kind === 'worktree' || c.kind === 'detached') FS[c.path] = REPO_FILES

const tilde = (path: string) => (path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path)
const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? '/'

function resolve(cwd: string, arg: string): string {
  const raw = arg === '~' || arg === '' ? HOME : arg.startsWith('~/') ? HOME + arg.slice(1) : arg.startsWith('/') ? arg : `${cwd}/${arg}`
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function placeOf(path: string): Place {
  const checkout = CHECKOUTS.filter((c) => path === c.path || path.startsWith(`${c.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
  if (checkout) {
    const { kind, repoRoot, repoName, branch, head } = checkout
    return { key: checkout.path, kind, name: branch ?? head ?? basename(checkout.path), path: checkout.path, repoRoot, repoName, branch, head, missing: false }
  }
  const scratch = path === HOME
  return { key: path, kind: scratch ? 'scratch' : 'folder', name: scratch ? '~' : basename(path), path, repoRoot: null, repoName: null, branch: null, head: null, missing: !(path in FS) }
}

const color = { dir: '\x1b[34m', dim: '\x1b[90m', green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m', claude: '\x1b[38;2;217;119;87m', bold: '\x1b[1m', off: '\x1b[0m' }

function prompt(cwd: string): string {
  const place = placeOf(cwd)
  const branch = place.branch ?? (place.head ? `(${place.head})` : '')
  return `${color.cyan}${tilde(cwd)}${color.off}${branch ? ` ${color.magenta}${branch}${color.off}` : ''} ${color.dim}❯${color.off} `
}

const banner = (kind: 'claude' | 'codex', cwd: string) =>
  kind === 'claude'
    ? `${color.claude}╭───────────────────────────────────────╮\r\n│ ✻ ${color.off}${color.bold}Welcome to Claude Code${color.off}${color.claude}              │\r\n│   ${color.off}${color.dim}cwd: ${tilde(cwd).padEnd(32).slice(0, 32)}${color.off}${color.claude}│\r\n╰───────────────────────────────────────╯${color.off}\r\n\r\n`
    : `${color.bold}>_ OpenAI Codex${color.off} ${color.dim}(research preview)${color.off}\r\n${color.dim}   directory: ${tilde(cwd)}${color.off}\r\n\r\n`

type DataListener = (bytes: Uint8Array, seq: number) => void

interface Sim {
  info: SessionInfo
  out: string
  line: string
  busy: boolean
  listeners: Set<DataListener>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function mockApi(): Api {
  const sims = new Map<string, Sim>()
  const listeners = new Set<(e: SessionEvent) => void>()
  let next = 1

  const fire = (e: SessionEvent) => listeners.forEach((cb) => cb(e))
  const emit = (sim: Sim, text: string) => {
    const bytes = encoder.encode(text)
    const seq = sim.info.seq
    sim.out += text
    sim.info.seq += bytes.length
    sim.listeners.forEach((cb) => cb(bytes, seq))
  }
  const setStatus = (sim: Sim, status: SessionStatus) => {
    sim.info.status = status
    fire({ type: 'status', session: sim.info.id, status })
  }
  const setTitle = (sim: Sim, title: string) => {
    sim.info.title = title
    fire({ type: 'title', session: sim.info.id, title })
  }

  function fakeClaude(sim: Sim) {
    sim.busy = true
    emit(sim, banner('claude', sim.info.cwd))
    emit(sim, `${color.dim}> ${color.off}Look around this folder\r\n\r\n${color.claude}✻${color.off} Thinking...\r\n`)
    setStatus(sim, 'running')
    setTitle(sim, 'Claude Code')
    setTimeout(() => {
      if (!sims.has(sim.info.id)) return
      emit(sim, `\r\n${color.green}⏺${color.off} Done. Nothing to change here.\r\n\r\n`)
      setStatus(sim, 'done')
      sim.busy = false
      if (sim.info.kind === 'shell') emit(sim, prompt(sim.info.cwd))
    }, 3000)
  }

  function run(sim: Sim, line: string) {
    const [cmd = '', ...args] = line.trim().split(/\s+/)
    const cwd = sim.info.cwd
    if (cmd === 'ls') {
      const dir = resolve(cwd, args[0] ?? '.')
      const items = FS[dir]
      emit(sim, items ? `${items.map((i) => (i.endsWith('/') ? `${color.dir}${i.slice(0, -1)}${color.off}` : i)).join('  ')}\r\n` : `ls: ${args[0]}: No such file or directory\r\n`)
    } else if (cmd === 'pwd') emit(sim, `${cwd}\r\n`)
    else if (cmd === 'cd') {
      const dir = resolve(cwd, args[0] ?? '~')
      if (dir in FS) {
        sim.info.cwd = dir
        fire({ type: 'cwd', session: sim.info.id, cwd: dir })
      } else emit(sim, `cd: no such file or directory: ${args[0]}\r\n`)
    } else if (cmd === 'clear') emit(sim, '\x1b[2J\x1b[3J\x1b[H')
    else if (cmd === 'echo') emit(sim, `${args.join(' ')}\r\n`)
    else if (cmd === 'claude') return fakeClaude(sim)
    else if (cmd === 'exit') return exit(sim, 0)
    else if (cmd) emit(sim, `zsh: command not found: ${cmd}\r\n`)
    if (cmd) setTitle(sim, line.trim())
    emit(sim, prompt(sim.info.cwd))
  }

  function exit(sim: Sim, code: number | null) {
    if (sim.info.status === 'exited') return
    sim.info.status = 'exited'
    sim.info.exitCode = code
    sim.info.pid = null
    fire({ type: 'exit', session: sim.info.id, code })
    fire({ type: 'status', session: sim.info.id, status: 'exited' })
  }

  function type(sim: Sim, data: string) {
    if (sim.info.status === 'exited' || data.startsWith('\x1b')) return
    for (const ch of data) {
      if (sim.busy) continue
      if (ch === '\r') {
        emit(sim, '\r\n')
        const line = sim.line
        sim.line = ''
        if (sim.info.kind === 'shell') run(sim, line)
        else emit(sim, `${color.dim}(this fake agent only listens)${color.off}\r\n`)
      } else if (ch === '\x7f') {
        if (!sim.line) continue
        sim.line = sim.line.slice(0, -1)
        emit(sim, '\b \b')
      } else if (ch === '\x03') {
        sim.line = ''
        emit(sim, `^C\r\n${sim.info.kind === 'shell' ? prompt(sim.info.cwd) : ''}`)
      } else if (ch >= ' ') {
        sim.line += ch
        emit(sim, ch)
      }
    }
  }

  function spawn(opts: CreateSession, id = `m${next++}`, createdAt = Date.now()): Sim {
    const cwd = opts.cwd ?? HOME
    const kind = opts.kind
    const info: SessionInfo = {
      id,
      kind,
      cwd,
      title: opts.title ?? (kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : 'zsh'),
      status: kind === 'shell' ? 'idle' : 'running',
      pid: 40000 + next,
      exitCode: null,
      cols: opts.cols,
      rows: opts.rows,
      createdAt,
      command: opts.command ?? [],
      seq: 0,
      agentSession: null,
      routine: opts.routine ?? null,
    }
    const sim: Sim = { info, out: '', line: '', busy: false, listeners: new Set() }
    sims.set(id, sim)
    if (kind === 'shell') emit(sim, prompt(cwd))
    else emit(sim, banner(kind === 'codex' ? 'codex' : 'claude', cwd))
    return sim
  }

  const seedEmpty = new URLSearchParams(location.search).get('seed') === 'empty'
  if (!seedEmpty) seed(spawn, emit)

  const get = (id: string) => {
    const sim = sims.get(id)
    if (!sim) throw new Error(`no such session: ${id}`)
    return sim
  }

  window.treeixMock = {
    restart() {
      fire({ type: 'daemon', state: 'disconnected' })
      setTimeout(() => fire({ type: 'daemon', state: 'connected' }), 1500)
    },
  }

  return {
    hello: async () => ({ proto: 1, build: 'mock', daemonPid: 0 }),
    sessions: async () => [...sims.values()].map((s) => ({ ...s.info })),
    async create(opts) {
      const sim = spawn(opts)
      if (opts.kind !== 'shell') {
        setTimeout(() => setStatus(sim, 'done'), 3000)
      }
      fire({ type: 'created', info: { ...sim.info } })
      return { ...sim.info }
    },
    async attach(id, onData): Promise<Attachment> {
      const sim = get(id)
      sim.listeners.add(onData)
      return {
        snapshot: encoder.encode(sim.out),
        seq: sim.info.seq,
        info: { ...sim.info },
        detach: async () => void sim.listeners.delete(onData),
      }
    },
    async write(id, data) {
      type(get(id), typeof data === 'string' ? data : decoder.decode(data))
    },
    async resize(id, cols, rows) {
      Object.assign(get(id).info, { cols, rows })
    },
    ack: async () => {},
    async kill(id) {
      const sim = sims.get(id)
      if (sim) exit(sim, null)
    },
    async remove(id) {
      if (!sims.delete(id)) return
      fire({ type: 'removed', session: id })
    },
    getUi: async () => localStorage.getItem(UI_KEY),
    putUi: async (json) => localStorage.setItem(UI_KEY, json),
    places: async (paths) => paths.map(placeOf),
    homeDir: async () => HOME,
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

declare global {
  interface Window {
    treeixMock?: { restart(): void }
  }
}

/** Fixed ids, so a layout saved in localStorage still matches after a reload */
function seed(spawn: (opts: CreateSession, id: string, createdAt: number) => Sim, emit: (sim: Sim, text: string) => void) {
  const redo = `${TREEIX}/.worktrees/feat-terminal-redo`
  const rows: [string, CreateSession['kind'], string, string, SessionStatus, string[]][] = [
    ['s1', 'shell', TREEIX, 'bun dev', 'running', ['bun dev', `${color.dim}$ vite${color.off}`, '', `  ${color.green}VITE v7.3.6${color.off}  ready in 412 ms`, '', `  ${color.green}➜${color.off}  Local:   http://localhost:5173/`]],
    ['s2', 'shell', TREEIX, 'zsh', 'idle', ['git status -sb', `${color.green}## main...origin/main${color.off} [behind 3]`]],
    ['s3', 'shell', `${TREEIX}/packages/ui`, 'ui tests', 'running', ['bun test --watch', 'bun test v1.4.2', '', ` ${color.green}24 pass${color.off}`, ' 0 fail']],
    ['s4', 'claude', redo, 'Redo terminal: blocks + splits', 'needs', ['Redo the terminal pane: blocks and recursive splits', `${color.claude}⏺${color.off} Update(packages/plugins/terminal/main/pty.ts)`, '  Updated with 12 additions and 3 removals', '', 'Do you want to make this edit to pty.ts?', `${color.claude}❯ 1. Yes${color.off}`, '  2. No, and tell Claude what to do differently']],
    ['s5', 'codex', redo, 'Stress test PTY throughput', 'done', ['Stress test PTY throughput', '20 sessions · 1000 MB in 2.43s · 412 MB/s', 'p50 frame 4.1ms · p99 frame 9.8ms']],
    ['s6', 'claude', `${TREEIX}/.worktrees/fix-pty-leak`, 'Close pty fd on pane close', 'running', ['Close the pty fd when a pane closes', `${color.claude}✻${color.off} Reading packages/plugins/terminal/main/pty.ts...`]],
    ['s7', 'claude', `${TREEIX}/.worktrees/pr-405`, 'Review #405', 'done', ['Review PR #405', `${color.green}⏺${color.off} Looks good. Two nits left as comments.`]],
    ['s8', 'shell', `${HOME}/dotfiles`, 'zsh', 'idle', ['./install.sh', 'linked .zshrc .gitconfig']],
    ['s9', 'shell', `${HOME}/Downloads`, 'zsh', 'idle', ['ls', `${color.dir}invoices${color.off}  report.pdf  IMG_2041.heic`]],
    ['s10', 'shell', HOME, 'zsh', 'idle', []],
  ]
  rows.forEach(([id, kind, cwd, title, status, [first, ...lines]], i) => {
    const sim = spawn({ kind, cwd, title, cols: 80, rows: 24 }, id, 1_700_000_000_000 + i)
    sim.info.status = status
    if (!first) return
    if (kind === 'shell') emit(sim, `${first}\r\n${lines.map((l) => `${l}\r\n`).join('')}${status === 'running' ? '' : prompt(cwd)}`)
    else emit(sim, `${color.dim}>${color.off} ${first}\r\n\r\n${lines.map((l) => `${l}\r\n`).join('')}`)
  })
}
