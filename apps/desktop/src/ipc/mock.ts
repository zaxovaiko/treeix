import {
  SAVE_CONFLICT,
  type Api,
  type Attachment,
  type Branch,
  type Change,
  type ChangeStatus,
  type Check,
  type CreateSession,
  type FilePatch,
  type FsChange,
  type GitStatus,
  type HistoryEntry,
  type NewWorktree,
  type Place,
  type PlaceKind,
  type Provider,
  type PullRequest,
  type SessionEvent,
  type SessionInfo,
  type SessionRecord,
  type SessionStatus,
  type Worktree,
  type WorktreeStep,
} from './api'
import { agentsMock } from './mockAgents'
import { browserMock } from './mockBrowser'
import { chatMock } from './mockChat'
import { plansMock } from './mockPlans'
import { routinesMock } from './mockRoutines'
import { settingsMock } from './mockSettings'
import { voiceMock } from './mockVoice'

// In-browser fake daemon for the dev server and visual checks: a tiny shell over a fake file tree.
// `?seed=empty` starts with no sessions (first run); `window.treeixMock.restart()` simulates a daemon restart

const HOME = '/Users/me'
const TREEIX = `${HOME}/projects/treeix`
const BETFEEL = `${HOME}/projects/betfeel/api`
const UI_KEY = 'treeix-ui'

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
  repo(`${TREEIX}/.claude/worktrees/feat+terminal-redo`, 'worktree', 'feat/terminal-redo'),
  repo(`${TREEIX}/.claude/worktrees/fix+pty-leak`, 'worktree', 'fix/pty-leak'),
  repo(`${TREEIX}/.claude/worktrees/pr-405`, 'detached', null, '7d2c9e1'),
  repo(`${TREEIX}/.claude/worktrees/fix+hotkey-focus`, 'worktree', 'fix/hotkey-focus'),
  repo(`${HOME}/dotfiles`, 'git', 'main', null, `${HOME}/dotfiles`, 'dotfiles'),
  repo(BETFEEL, 'root', 'fix/odds-rounding', null, BETFEEL, 'betfeel-api'),
  repo(`${BETFEEL}/.claude/worktrees/feat+bonus-ledger`, 'worktree', 'feat/bonus-ledger', null, BETFEEL, 'betfeel-api'),
  repo(`${BETFEEL}/.claude/worktrees/chore+nest-11`, 'worktree', 'chore/nest-11', null, BETFEEL, 'betfeel-api'),
]

const REPO_FILES = ['apps/', 'crates/', 'packages/', 'docs/', 'Cargo.toml', 'package.json', 'README.md', 'bun.lock']
const FS: Record<string, string[]> = {
  [HOME]: ['projects/', 'dotfiles/', 'Downloads/', 'Desktop/', 'notes.md'],
  [`${HOME}/projects`]: ['treeix/', 'betfeel/', 'landing/'],
  [`${HOME}/projects/betfeel`]: ['api/'],
  [BETFEEL]: ['prisma/', 'src/', 'test/', 'package.json', 'README.md', '.claude/'],
  [`${HOME}/projects/landing`]: ['index.html', 'styles.css', 'README.md'],
  [TREEIX]: [...REPO_FILES, '.claude/'],
  [`${TREEIX}/.claude`]: ['worktrees/'],
  [`${TREEIX}/.claude/worktrees`]: ['feat+terminal-redo/', 'fix+pty-leak/', 'pr-405/', 'fix+hotkey-focus/'],
  [`${TREEIX}/apps`]: ['desktop/', 'next/'],
  [`${TREEIX}/apps/next`]: ['src/', 'src-tauri/', 'package.json', 'vite.config.ts'],
  [`${TREEIX}/packages`]: ['ui/', 'plugins/'],
  [`${TREEIX}/packages/ui`]: ['src/', 'package.json'],
  [`${HOME}/dotfiles`]: ['.zshrc', '.gitconfig', 'install.sh'],
  [`${HOME}/Downloads`]: ['invoices/', 'report.pdf', 'IMG_2041.heic'],
  [`${HOME}/Downloads/invoices`]: ['2026-09.pdf', '2026-10.pdf'],
  [`${HOME}/Desktop`]: ['receipts/'],
}
for (const c of CHECKOUTS) if ((c.kind === 'worktree' || c.kind === 'detached') && c.repoRoot === TREEIX) FS[c.path] = REPO_FILES

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
    offline: false,
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
        ack: async () => {},
        detach: async () => void sim.listeners.delete(onData),
      }
    },
    async write(id, data) {
      type(get(id), typeof data === 'string' ? data : decoder.decode(data))
    },
    async resize(id, cols, rows) {
      Object.assign(get(id).info, { cols, rows })
    },
    async kill(id) {
      const sim = sims.get(id)
      if (sim) exit(sim, null)
    },
    async remove(id) {
      if (!sims.delete(id)) return
      fire({ type: 'removed', session: id })
    },
    async restart(id) {
      const sim = get(id)
      Object.assign(sim.info, { exitCode: null, pid: 40000 + next++ })
      setStatus(sim, sim.info.kind === 'shell' ? 'idle' : 'running')
      // Like ptyd: the old screen stays and the new run starts on a fresh line
      emit(sim, '\x1b[0m\r\n')
      emit(sim, sim.info.kind === 'shell' ? prompt(sim.info.cwd) : banner(sim.info.kind === 'codex' ? 'codex' : 'claude', sim.info.cwd))
    },
    async clear(id) {
      const sim = get(id)
      sim.out = sim.out.slice(sim.out.lastIndexOf('\n') + 1)
    },
    getUi: async () => localStorage.getItem(UI_KEY),
    putUi: async (json) => localStorage.setItem(UI_KEY, json),
    places: async (paths) => paths.map(placeOf),
    homeDir: async () => HOME,
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    ...phase3(),
    ...agentsMock(),
    ...chatMock(),
    ...settingsMock(),
    ...routinesMock(),
    ...browserMock(),
    ...plansMock(),
    ...voiceMock(),
  }
}

declare global {
  interface Window {
    /** `offline = true` makes the next worktree fetch fail, for the Retry / Continue without fetching flow */
    treeixMock?: { restart(): void; offline: boolean }
  }
}

/** Fixed ids, so a layout saved in localStorage still matches after a reload */
function seed(spawn: (opts: CreateSession, id: string, createdAt: number) => Sim, emit: (sim: Sim, text: string) => void) {
  const redo = `${TREEIX}/.claude/worktrees/feat+terminal-redo`
  const rows: [string, CreateSession['kind'], string, string, SessionStatus, string[]][] = [
    ['s1', 'shell', TREEIX, 'bun dev', 'running', ['bun dev', `${color.dim}$ vite${color.off}`, '', `  ${color.green}VITE v7.3.6${color.off}  ready in 412 ms`, '', `  ${color.green}➜${color.off}  Local:   http://localhost:5173/`]],
    ['s2', 'shell', TREEIX, 'zsh', 'idle', ['git status -sb', `${color.green}## main...origin/main${color.off} [behind 3]`]],
    ['s3', 'shell', `${TREEIX}/packages/ui`, 'ui tests', 'running', ['bun test --watch', 'bun test v1.4.2', '', ` ${color.green}24 pass${color.off}`, ' 0 fail']],
    ['s4', 'claude', redo, 'Redo terminal: blocks + splits', 'needs', ['Redo the terminal pane: blocks and recursive splits', `${color.claude}⏺${color.off} Update(packages/plugins/terminal/main/pty.ts)`, '  Updated with 12 additions and 3 removals', '', 'Do you want to make this edit to pty.ts?', `${color.claude}❯ 1. Yes${color.off}`, '  2. No, and tell Claude what to do differently']],
    ['s5', 'codex', redo, 'Stress test PTY throughput', 'done', ['Stress test PTY throughput', '20 sessions · 1000 MB in 2.43s · 412 MB/s', 'p50 frame 4.1ms · p99 frame 9.8ms']],
    ['s6', 'claude', `${TREEIX}/.claude/worktrees/fix+pty-leak`, 'Close pty fd on pane close', 'running', ['Close the pty fd when a pane closes', `${color.claude}✻${color.off} Reading packages/plugins/terminal/main/pty.ts...`]],
    ['s7', 'claude', `${TREEIX}/.claude/worktrees/pr-405`, 'Review #405', 'watching', ['Review PR #405', `${color.green}⏺${color.off} Looks good. Two nits left as comments.`]],
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

// Phase 3 demo data, from the prototype (data.js): repos, worktrees, branches, changes, PRs, closed sessions

type Phase3 = Omit<Api, 'hello' | 'sessions' | 'create' | 'attach' | 'write' | 'resize' | 'kill' | 'remove' | 'restart' | 'clear' | 'getUi' | 'putUi' | 'places' | 'homeDir' | 'onEvent' | keyof Phase45>
type Phase45 = ReturnType<typeof agentsMock> & ReturnType<typeof chatMock> & ReturnType<typeof settingsMock> & Phase67
type Phase67 = ReturnType<typeof routinesMock> & ReturnType<typeof browserMock> & ReturnType<typeof plansMock> & ReturnType<typeof voiceMock>

const HOUR = 3_600_000
const DOWNLOADS = `${HOME}/Downloads`
const DOTFILES = `${HOME}/dotfiles`

interface RepoMeta {
  provider: Provider | null
  files: string[]
  ignored: string[]
  /** name, last author, hours since the last commit, only on origin */
  branches: [string, string, number, boolean][]
  /** Worktrees whose folder is gone */
  missing: Worktree[]
}

const REPOS: Record<string, RepoMeta> = {
  [TREEIX]: {
    provider: 'github',
    files: [
      'apps/desktop/scripts/stress.ts', 'apps/desktop/src/main/hotkeyWindow.ts', 'apps/desktop/src/main/index.ts', 'apps/desktop/src/renderer/App.tsx',
      'apps/desktop/src/renderer/Explorer.tsx', 'apps/desktop/package.json', 'packages/plugins/dependencies/main/resolve.test.ts',
      'packages/plugins/dependencies/main/resolve.ts', 'packages/plugins/dependencies/main/scan.ts', 'packages/plugins/terminal/main/coalesce.ts',
      'packages/plugins/terminal/main/hooks.ts', 'packages/plugins/terminal/main/pty.ts', 'packages/plugins/terminal/main/ptyHost.ts',
      'packages/plugins/terminal/main/transcripts.ts', 'packages/plugins/terminal/renderer/agentStatus.ts', 'packages/plugins/terminal/renderer/blocks.ts',
      'packages/plugins/terminal/renderer/fileLinks.test.ts', 'packages/plugins/terminal/renderer/fileLinks.ts', 'packages/plugins/terminal/renderer/groups.ts',
      'packages/plugins/terminal/renderer/index.tsx', 'packages/plugins/terminal/renderer/paneLayout.test.ts', 'packages/plugins/terminal/renderer/paneLayout.ts',
      'packages/plugins/terminal/renderer/SessionPanel.tsx', 'packages/plugins/terminal/renderer/terminals.ts', 'packages/plugins/terminal/package.json',
      'packages/ui/src/Button.test.tsx', 'packages/ui/src/Button.tsx', 'packages/ui/package.json', 'bun.lock', 'package.json', 'README.md',
    ],
    ignored: ['.env', 'node_modules/'],
    branches: [
      ['main', 'you', 2, false],
      ['feat/terminal-redo', 'you', 3, false],
      ['fix/pty-leak', 'you', 5, false],
      ['fix/hotkey-focus', 'you', 72, false],
      ['exp/gpui-spike', 'you', 96, false],
      ['origin/feat/plugin-api', 'anna.n', 48, true],
      ['origin/fix/scrollback-limit', 'mkowalski', 120, true],
    ],
    missing: [{ path: `${TREEIX}/.claude/worktrees/exp+gpui-spike`, head: '1f0c3b7', branch: 'exp/gpui-spike', main: false, missing: true }],
  },
  [BETFEEL]: {
    provider: 'gitlab',
    files: [
      'prisma/migrations/20260901_init/migration.sql', 'prisma/schema.prisma', 'src/bonus/bonus.module.ts', 'src/bonus/grant.service.ts',
      'src/bonus/ledger.service.ts', 'src/common/money.ts', 'src/odds/round.test.ts', 'src/odds/round.ts', 'src/prisma/prisma.service.ts',
      'src/app.module.ts', 'src/main.ts', 'test/e2e/bonus.e2e-spec.ts', 'test/e2e/seed.ts', 'docker-compose.yml', 'package.json', 'pnpm-lock.yaml', 'README.md',
    ],
    ignored: ['.env', 'dist/', 'node_modules/'],
    branches: [
      ['main', 'anna.n', 20, false],
      ['fix/odds-rounding', 'you', 4, false],
      ['feat/bonus-ledger', 'you', 3, false],
      ['chore/nest-11', 'you', 30, false],
      ['origin/feat/odds-feed', 'anna.n', 24, true],
    ],
    missing: [],
  },
  [DOTFILES]: {
    provider: null,
    files: ['git/.gitconfig', 'nvim/init.lua', 'zsh/.zshrc', 'install.sh', 'README.md'],
    ignored: [],
    branches: [['main', 'you', 200, false]],
    missing: [],
  },
}

/** Plain folders: listFiles walks them too */
const FOLDERS: Record<string, string[]> = {
  [DOWNLOADS]: ['invoices/2026-08.pdf', 'invoices/2026-09.pdf', 'invoices/index.csv', 'standup.mov', 'standup.mp3', 'summary.md'],
  [HOME]: ['notes.md'],
}

/** [path, status letter (U untracked), added lines, removed lines] */
type Row = [string, 'A' | 'M' | 'D' | 'U', number, number]

interface CheckoutState {
  upstream: string | null
  ahead: number
  behind: number
  gone: boolean
  merged: boolean
  rebase: { step: number; total: number } | null
  conflicts: string[]
  /** Committed on the branch, vs the base */
  base: Row[]
  /** Uncommitted */
  local: Row[]
  head: string
}

const checkoutState = (s: Partial<CheckoutState>): CheckoutState => ({
  upstream: null, ahead: 0, behind: 0, gone: false, merged: false, rebase: null, conflicts: [], base: [], local: [], head: '9c1e2d4', ...s,
})

const STATE: Record<string, CheckoutState> = {
  [TREEIX]: checkoutState({ upstream: 'origin/main', behind: 3, local: [['apps/desktop/src/renderer/App.tsx', 'M', 2, 1]] }),
  [`${TREEIX}/.claude/worktrees/feat+terminal-redo`]: checkoutState({
    upstream: 'origin/feat/terminal-redo',
    ahead: 2,
    head: 'a41c9e2',
    base: [
      ['packages/plugins/terminal/main/pty.ts', 'M', 34, 6], ['packages/plugins/terminal/main/coalesce.ts', 'M', 12, 4],
      ['packages/plugins/terminal/main/ptyHost.ts', 'A', 118, 0], ['packages/plugins/terminal/renderer/blocks.ts', 'A', 164, 0],
      ['packages/plugins/terminal/renderer/terminals.ts', 'M', 96, 71], ['packages/plugins/terminal/renderer/paneLayout.ts', 'M', 40, 12],
      ['packages/plugins/terminal/renderer/groups.ts', 'D', 0, 88], ['apps/desktop/scripts/stress.ts', 'M', 210, 12],
      ['packages/plugins/dependencies/main/scan.ts', 'M', 168, 20],
    ],
    local: [
      ['packages/plugins/terminal/main/pty.ts', 'M', 12, 3], ['packages/plugins/terminal/renderer/blocks.ts', 'M', 20, 0],
      ['packages/plugins/terminal/renderer/blocks.test.ts', 'U', 18, 0],
    ],
  }),
  [`${TREEIX}/.claude/worktrees/fix+pty-leak`]: checkoutState({
    upstream: 'origin/fix/pty-leak',
    head: '3b7f0aa',
    base: [['packages/plugins/terminal/renderer/paneLayout.test.ts', 'M', 32, 7]],
    local: [['packages/plugins/terminal/renderer/paneLayout.ts', 'M', 6, 2]],
  }),
  [`${TREEIX}/.claude/worktrees/pr-405`]: checkoutState({
    head: '7d2c9e1',
    base: [
      ['packages/plugins/dependencies/main/scan.ts', 'M', 540, 388], ['packages/plugins/dependencies/main/resolve.ts', 'A', 486, 0],
      ['packages/plugins/dependencies/main/resolve.test.ts', 'A', 178, 0],
    ],
  }),
  [`${TREEIX}/.claude/worktrees/fix+hotkey-focus`]: checkoutState({ upstream: 'origin/fix/hotkey-focus', gone: true, merged: true, head: 'e02d5c1' }),
  [DOTFILES]: checkoutState({ head: '5c2e7d1', local: [['zsh/.zshrc', 'M', 2, 1]] }),
  [BETFEEL]: checkoutState({
    ahead: 1,
    head: 'e41b9c2',
    base: [['src/odds/round.ts', 'M', 4, 2], ['src/odds/round.test.ts', 'M', 18, 0]],
    local: [['src/odds/round.ts', 'M', 1, 1]],
  }),
  [`${BETFEEL}/.claude/worktrees/feat+bonus-ledger`]: checkoutState({
    upstream: 'origin/feat/bonus-ledger',
    behind: 1,
    head: 'c7a19f0',
    base: [
      ['prisma/schema.prisma', 'M', 3, 0], ['src/bonus/ledger.service.ts', 'M', 96, 40],
      ['prisma/migrations/20261021_ledger_idempotency/migration.sql', 'A', 12, 0], ['src/bonus/ledger.service.test.ts', 'A', 201, 0],
    ],
  }),
  [`${BETFEEL}/.claude/worktrees/chore+nest-11`]: checkoutState({
    upstream: 'origin/chore/nest-11',
    head: '0d4e6b1',
    rebase: { step: 1, total: 5 },
    conflicts: ['package.json', 'pnpm-lock.yaml'],
    base: [['package.json', 'M', 6, 6], ['pnpm-lock.yaml', 'M', 412, 380], ['src/main.ts', 'M', 3, 3]],
    local: [['package.json', 'M', 4, 2], ['pnpm-lock.yaml', 'M', 12, 9]],
  }),
}

/** PR rows: number, title, author, hours ago, CI [status, done, total], review, +, -, source branch, extra */
const PRS: PullRequest[] = (
  [
    [TREEIX, 'github', 412, 'feat(terminal): command blocks and split panes', 'you', 2, ['running', 3, 5], 'yours', 842, 213, 'feat/terminal-redo', 'a41c9e2', {}],
    [TREEIX, 'github', 409, 'fix(terminal): closing a pane frees its pty', 'you', 5, ['failed', 5, 5], 'yours', 32, 7, 'fix/pty-leak', '3b7f0aa', { draft: true }],
    [TREEIX, 'github', 405, 'feat(deps): module graph follows tsconfig paths and exports', 'mkowalski', 24, ['passed', 5, 5], 'requested', 1204, 388, 'feat/deps-graph', '7d2c9e1', {}],
    [TREEIX, 'github', 401, 'fix(hotkey): the hotkey window leaves focus on the app below', 'you', 72, ['passed', 5, 5], null, 9, 3, 'fix/hotkey-focus', 'e02d5c1', { state: 'merged' }],
    [TREEIX, 'github', 398, 'docs: plugin authoring guide', 'anna.n', 96, ['passed', 5, 5], 'requested', 214, 12, 'docs/plugins', 'b41e0aa', {}],
    [BETFEEL, 'gitlab', 231, 'Ledger idempotency keys', 'you', 3, ['failed', 4, 4], 'yours', 312, 40, 'feat/bonus-ledger', 'c7a19f0', { changesRequested: true }],
  ] as const
).map(([repoPath, provider, number, title, author, hours, [status, done, total], review, additions, deletions, sourceBranch, head, extra]) => {
  const web = provider === 'github' ? `https://github.com/you/treeix/pull/${number}` : `https://gitlab.com/betfeel/api/-/merge_requests/${number}`
  const state = 'state' in extra ? extra.state : 'open'
  return {
    provider,
    repoPath,
    number,
    title,
    author,
    authorAvatarUrl: null,
    sourceBranch,
    targetBranch: 'main',
    head,
    state,
    draft: 'draft' in extra,
    updatedAt: new Date(Date.now() - hours * HOUR).toISOString(),
    url: web,
    additions,
    deletions,
    changedFiles: provider === 'github' ? 3 : null,
    review: review && state === 'open' ? { state: review, newCommits: 0, changesRequested: 'changesRequested' in extra } : null,
    conflicts: false,
    pipeline: { status, done, total, url: `${web}/checks` },
  }
})

const CHECKS = ['build', 'lint', 'typecheck', 'unit', 'e2e']

/** kind, title, cwd, branch, days ago, messages, cost, first prompt */
const RECORDS: SessionRecord[] = (
  [
    ['claude', 'Explorer: git status colors', TREEIX, 'main', 1, 64, 3.1, 'Color files by git status like VS Code...'],
    ['codex', 'GitLab MRs next to GitHub PRs', TREEIX, 'main', 1, 22, 0.88, 'List MRs from glab in the same PR list...'],
    ['claude', 'Bonus grants applied twice', `${BETFEEL}/.claude/worktrees/feat+bonus-ledger`, 'feat/bonus-ledger', 1, 41, 2.05, 'Grants sometimes apply twice after a retry...'],
    ['shell', 'pnpm prisma studio', BETFEEL, 'fix/odds-rounding', 1, null, null, null],
    ['codex', 'GPUI terminal spike', `${TREEIX}/.claude/worktrees/exp+gpui-spike`, 'exp/gpui-spike', 3, 17, 0.95, 'Spike a GPUI terminal view on alacritty_terminal...'],
    ['claude', 'Graph: follow re-exports', `${TREEIX}/.claude/worktrees/feat+graph-reexports`, 'feat/graph-reexports', 5, 27, 1.4, 'The graph misses edges through index.ts re-exports...'],
    ['codex', 'Speaker labels in meeting notes', TREEIX, 'main', 6, 33, 1.21, 'Label speakers in meeting transcripts...'],
    ['claude', 'Rename invoices by vendor', DOWNLOADS, null, 6, 9, 0.31, 'Rename the PDFs in invoices/ to vendor-date...'],
    ['claude', 'Convert HEIC photos to JPG', HOME, null, 6, 6, 0.12, 'Convert the HEIC photos on my Desktop to JPG...'],
    ['claude', 'Review requested PRs', `${TREEIX}/.claude/worktrees/pr-412`, 'fix/login-redirect', 0, 14, 0.62, 'Review PR #412 "Fix login redirect" by octocat...'],
  ] as const
).map(([kind, title, cwd, branch, days, messages, cost, firstPrompt], i) => {
  const closedAt = Date.now() - days * 24 * HOUR - i * HOUR
  const command = kind === 'shell' ? [] : [kind]
  return {
    id: `h${i + 1}`,
    kind,
    title,
    cwd,
    branch,
    repoRoot: cwd.startsWith(TREEIX) ? TREEIX : cwd.startsWith(BETFEEL) ? BETFEEL : null,
    agentSession: kind === 'shell' ? null : `0d9b${i}c1e-6f2a-4b7e-9a51-3e8c2f7d10a${i}`,
    command,
    createdAt: closedAt - 2 * HOUR,
    closedAt,
    messages,
    cost,
    firstPrompt,
    // The routine run in mockRoutines
    run: title === 'Review requested PRs' ? 'run-1' : null,
  }
})

const FILE_LOG: [string, string, number, string][] = [
  ['a41c9e2', 'You', 2, 'feat(terminal): blocks keep their exit status'],
  ['9c1e2d4', 'Claude', 24, 'fix: flush before exit'],
  ['3b7f0aa', 'anna.n', 144, 'refactor: split the PTY host'],
  ['e02d5c1', 'You', 504, 'feat: add the file'],
]

const BINARY = /\.(pdf|mov|mp3|png|jpe?g|heic|gif|zip)$/i
const CODE = /\.(tsx?|jsx?|rs|lua|sh)$/

const lines = (file: string, tag: string, count: number) =>
  Array.from({ length: count }, (_, i) => (CODE.test(file) ? `export const ${tag}${i + 1} = '${basename(file)} ${tag} ${i + 1}'` : `${tag} ${i + 1} of ${basename(file)}`))
const CONTEXT = 3
const frame = (file: string, middle: string[]) => [...lines(file, 'top', CONTEXT), ...middle, ...lines(file, 'end', CONTEXT)]

/** One-hunk unified diff of two versions (null = no file); the versions differ in one block, so trimming the common ends is exact */
function patchOf(path: string, before: string[] | null, after: string[] | null, oldPath: string | null = null): FilePatch {
  const a = before ?? []
  const b = after ?? []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const removed = a.slice(start, a.length - end)
  const added = b.slice(start, b.length - end)
  const status: ChangeStatus = !before ? 'added' : !after ? 'deleted' : oldPath ? 'renamed' : 'modified'
  if (!removed.length && !added.length) return { path, oldPath, status, patch: '', additions: 0, deletions: 0 }
  const from = Math.max(0, start - CONTEXT)
  const lead = a.slice(from, start)
  const tail = a.slice(a.length - end, Math.min(a.length, a.length - end + CONTEXT))
  const oldCount = lead.length + removed.length + tail.length
  const newCount = lead.length + added.length + tail.length
  const patch = [
    `diff --git a/${oldPath ?? path} b/${path}`,
    `--- ${before ? `a/${oldPath ?? path}` : '/dev/null'}`,
    `+++ ${after ? `b/${path}` : '/dev/null'}`,
    `@@ -${oldCount ? from + 1 : 0},${oldCount} +${newCount ? from + 1 : 0},${newCount} @@`,
    ...lead.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...tail.map((l) => ` ${l}`),
    '',
  ].join('\n')
  return { path, oldPath, status, patch, additions: added.length, deletions: removed.length }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dirName = (branch: string) => branch.replaceAll('/', '+')

function phase3(): Phase3 {
  /** Saved contents by absolute path; null = deleted */
  const edits = new Map<string, string | null>()
  /** Paths created / trashed per root, on top of the demo trees */
  const created = new Map<string, Set<string>>()
  const trashed = new Map<string, Set<string>>()
  const discarded = new Set<string>()
  const snapshots = new Map<string, HistoryEntry[]>()
  const snapshotText = new Map<string, string>()
  const placeWatchers = new Map<string, Set<(change: FsChange) => void>>()
  const fileWatchers = new Map<string, Set<() => void>>()
  const prs = PRS.map((pr) => ({ ...pr }))
  let records = [...RECORDS]

  const checkoutOf = (path: string) => CHECKOUTS.filter((c) => path === c.path || path.startsWith(`${c.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
  const stateOf = (root: string) => (STATE[root] ??= checkoutState({}))
  const setOf = (map: Map<string, Set<string>>, root: string) => {
    let set = map.get(root)
    if (!set) map.set(root, (set = new Set()))
    return set
  }
  const inside = (root: string, file: string) => {
    if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`outside ${root}: ${file}`)
    return `${root}/${file}`
  }
  const changed = (root: string, paths: string[], git = true) => {
    placeWatchers.get(root)?.forEach((cb) => cb({ paths, git }))
    for (const path of paths) fileWatchers.get(`${root}\0${path}`)?.forEach((cb) => cb())
  }

  // Three versions per file: base (the default branch), head (committed), working tree
  const rowOf = (rows: Row[], file: string) => rows.find(([path]) => path === file)
  function baseVersion(root: string, file: string): string[] | null {
    const row = rowOf(stateOf(root).base, file)
    if (row?.[1] === 'A') return null
    return frame(file, lines(file, 'line', row ? row[3] : 20))
  }
  function headVersion(root: string, file: string): string[] | null {
    const row = rowOf(stateOf(root).base, file)
    if (row?.[1] === 'D') return null
    if (row) return frame(file, lines(file, 'new', row[2]))
    return rowOf(stateOf(root).local, file)?.[1] === 'U' ? null : baseVersion(root, file)
  }
  function workingVersion(root: string, file: string): string[] | null {
    const path = `${root}/${file}`
    const edit = edits.get(path)
    if (edit !== undefined) return edit === null ? null : edit.split('\n')
    const head = headVersion(root, file)
    const row = discarded.has(path) ? undefined : rowOf(stateOf(root).local, file)
    if (!row) return head
    if (row[1] === 'U' || row[1] === 'A') return lines(file, 'wip', row[2])
    if (row[1] === 'D') return null
    const body = (head ?? []).slice(CONTEXT, -CONTEXT)
    return frame(file, [...body.slice(0, Math.max(0, body.length - row[3])), ...lines(file, 'wip', row[2])])
  }

  function filesOf(root: string): string[] | null {
    const checkout = checkoutOf(root)
    const listed = checkout ? REPOS[checkout.repoRoot]?.files : FOLDERS[root]
    if (!listed) return null
    const state = checkout ? stateOf(checkout.path) : null
    const all = new Set([...listed, ...(state ? [...state.base, ...state.local].filter(([, s]) => s === 'A' || s === 'U').map(([p]) => p) : []), ...setOf(created, root)])
    for (const [path, letter] of state?.base ?? []) if (letter === 'D') all.delete(path)
    for (const path of setOf(trashed, root)) all.delete(path)
    return [...all].filter((file) => !file.endsWith('/')).sort()
  }

  function localChanges(root: string): Change[] {
    const state = stateOf(root)
    const paths = new Set([...state.local.map(([p]) => p), ...[...edits.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1))])
    const out: Change[] = []
    for (const path of paths) {
      const head = headVersion(root, path)
      const working = workingVersion(root, path)
      if (head?.join('\n') === working?.join('\n')) continue
      const status: ChangeStatus = state.conflicts.includes(path) ? 'conflicted' : !head ? 'untracked' : !working ? 'deleted' : 'modified'
      out.push({ path, status, oldPath: null })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  function snapshot(root: string, file: string, text: string) {
    const key = `${root}\0${file}`
    const list = snapshots.get(key) ?? []
    const savedAt = Date.now()
    if (list[0] && savedAt - list[0].savedAt < 60_000) return
    const entry = { id: String(savedAt), savedAt, bytes: new TextEncoder().encode(text).length }
    snapshots.set(key, [entry, ...list].slice(0, 100))
    snapshotText.set(`${key}\0${entry.id}`, text)
  }
  // Two older versions of pty.ts, so File history has something on first open
  const pty = ['packages/plugins/terminal/main/pty.ts', `${TREEIX}/.claude/worktrees/feat+terminal-redo`] as const
  snapshots.set(`${pty[1]}\0${pty[0]}`, [26, 3].map((hours) => ({ id: String(Date.now() - hours * HOUR), savedAt: Date.now() - hours * HOUR, bytes: 1800 + hours })))
  for (const entry of snapshots.get(`${pty[1]}\0${pty[0]}`) ?? []) snapshotText.set(`${pty[1]}\0${pty[0]}\0${entry.id}`, frame(pty[0], lines(pty[0], `v${entry.bytes}`, 12)).join('\n'))

  function worktreesOf(repoPath: string): Worktree[] {
    const live = CHECKOUTS.filter((c) => c.repoRoot === repoPath && c.kind !== 'git' ? true : c.path === repoPath).map((c) => ({
      path: c.path,
      head: stateOf(c.path).head,
      branch: c.branch,
      main: c.path === c.repoRoot,
      missing: false,
    }))
    return [...live.sort((a, b) => Number(b.main) - Number(a.main)), ...(REPOS[repoPath]?.missing ?? [])]
  }

  const steps = new Map<string, Promise<string>>()
  async function addWorktree(request: NewWorktree, onStep: (step: WorktreeStep) => void): Promise<string> {
    const meta = REPOS[request.repoPath]
    if (!meta) throw new Error(`not a git repository: ${request.repoPath}`)
    const prefix = meta.provider === 'gitlab' ? 'mr' : 'pr'
    const name = request.pr !== null ? `${prefix}-${request.pr}` : dirName(request.branch ?? '')
    if (!name) throw new Error('a branch or a PR is required')
    const path = `${request.repoPath}/.claude/worktrees/${name}`
    const step = (s: WorktreeStep) => onStep({ ...s })

    const fetch = request.pr !== null ? `git fetch origin ${meta.provider === 'gitlab' ? `merge-requests/${request.pr}/head` : `pull/${request.pr}/head`}` : 'git fetch origin'
    if (request.skipFetch && request.pr === null) step({ step: 'fetch', state: 'skipped', command: fetch, error: null })
    else {
      step({ step: 'fetch', state: 'running', command: fetch, error: null })
      await sleep(700)
      if (window.treeixMock?.offline) {
        const error = "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\nfatal: Could not read from remote repository."
        step({ step: 'fetch', state: 'failed', command: fetch, error })
        throw new Error(error)
      }
      step({ step: 'fetch', state: 'done', command: fetch, error: null })
    }

    const existing = CHECKOUTS.find((c) => c.path === path)
    const add = request.pr !== null ? `git worktree add --detach ${path} FETCH_HEAD` : `git worktree add ${path} ${request.branch}`
    step({ step: 'add', state: 'running', command: add, error: null })
    await sleep(300)
    if (!existing) {
      const pr = prs.find((p) => p.repoPath === request.repoPath && p.number === request.pr)
      const branch = request.pr !== null ? null : request.branch
      CHECKOUTS.push(repo(path, request.pr !== null ? 'detached' : 'worktree', branch, pr?.head ?? null, request.repoPath, basename(request.repoPath)))
      STATE[path] = checkoutState({ head: pr?.head ?? '9c1e2d4', upstream: branch ? `origin/${branch}` : null })
      FS[path] = REPO_FILES
      if (branch && !meta.branches.some(([n]) => n === branch)) meta.branches.unshift([branch, 'you', 0, false])
    }
    step({ step: 'add', state: 'done', command: add, error: null })

    if (request.copyEnv) {
      step({ step: 'env', state: 'running', command: 'cp .env', error: null })
      await sleep(100)
      step({ step: 'env', state: meta.ignored.includes('.env') ? 'done' : 'skipped', command: 'cp .env', error: null })
    }
    if (request.setup) {
      step({ step: 'setup', state: 'running', command: request.setup, error: null })
      await sleep(1500)
      step({ step: 'setup', state: 'done', command: request.setup, error: null })
    }
    changed(request.repoPath, [], true)
    return path
  }

  return {
    listWorktrees: async (repoPath) => worktreesOf(repoPath),
    async gitStatus(path) {
      const checkout = checkoutOf(path)
      if (!checkout) return null
      const state = stateOf(checkout.path)
      const meta = REPOS[checkout.repoRoot]
      const status: GitStatus = {
        branch: checkout.branch,
        head: state.head,
        upstream: state.upstream,
        ahead: state.ahead,
        behind: state.behind,
        gone: state.gone,
        base: meta ? 'main' : null,
        baseAhead: checkout.branch === 'main' ? 0 : state.base.length ? Math.max(1, state.ahead) : 0,
        merged: state.merged,
        rebase: state.rebase,
        conflicts: [...state.conflicts],
        changes: localChanges(checkout.path),
      }
      return status
    },
    async diff(path, scope) {
      const checkout = checkoutOf(path)
      if (!checkout) return []
      const root = checkout.path
      if (scope === 'local') return localChanges(root).map((c) => patchOf(c.path, headVersion(root, c.path), workingVersion(root, c.path)))
      const paths = new Set([...stateOf(root).base.map(([p]) => p), ...localChanges(root).map((c) => c.path)])
      return [...paths].sort().map((p) => patchOf(p, baseVersion(root, p), workingVersion(root, p))).filter((p) => p.patch)
    },
    async readFileAt(root, file, rev) {
      inside(root, file)
      if (BINARY.test(file)) return null
      const version = rev === 'HEAD' ? headVersion(root, file) : /^[0-9a-f]{7,40}$/.test(rev) ? frame(file, lines(file, rev.slice(0, 7), 16)) : baseVersion(root, file)
      return version?.join('\n') ?? null
    },
    fileLog: async (root, file) => (inside(root, file), FILE_LOG.map(([sha, author, hours, subject]) => ({ sha, author, date: Math.floor((Date.now() - hours * HOUR) / 1000), subject }))),
    async commitDiff(root, sha, file) {
      const files = file ? [file] : (filesOf(root) ?? []).slice(0, 2)
      const older = FILE_LOG[FILE_LOG.findIndex(([s]) => s === sha) + 1]?.[0] ?? null
      return files.map((f) => patchOf(f, older ? frame(f, lines(f, older, 16)) : null, frame(f, lines(f, sha.slice(0, 7), 16))))
    },
    async listBranches(repoPath) {
      const meta = REPOS[repoPath]
      if (!meta) throw new Error(`not a git repository: ${repoPath}`)
      const worktrees = worktreesOf(repoPath)
      return meta.branches.map(([name, author, hours, remote]): Branch => {
        const state = STATE[worktrees.find((w) => w.branch === name)?.path ?? '']
        return {
          name,
          remote,
          ahead: state?.ahead ?? 0,
          behind: state?.behind ?? 0,
          gone: state?.gone ?? false,
          merged: state?.merged ?? false,
          committedAt: Math.floor((Date.now() - hours * HOUR) / 1000),
          author,
          worktree: worktrees.find((w) => w.branch === name)?.path ?? null,
        }
      })
    },
    // Close enough to git check-ref-format for the dialog's live check
    checkBranchName: async (name) => /^(?!\/|.*(\/\/|\.\.|@\{|\/\.|\.lock$|\/$|\.$))[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(name) && name !== '@',
    async createBranch(repoPath, name) {
      const meta = REPOS[repoPath]
      if (!meta) throw new Error(`not a git repository: ${repoPath}`)
      if (meta.branches.some(([n]) => n === name)) throw new Error(`fatal: a branch named '${name}' already exists`)
      meta.branches.unshift([name, 'you', 0, false])
    },
    async deleteBranch(repoPath, name, force) {
      const meta = REPOS[repoPath]
      if (!meta) throw new Error(`not a git repository: ${repoPath}`)
      const worktree = worktreesOf(repoPath).find((w) => w.branch === name && !w.missing)
      if (worktree) throw new Error(`error: cannot delete branch '${name}' used by worktree at '${worktree.path}'`)
      if (!force && !STATE[`${repoPath}/.claude/worktrees/${dirName(name)}`]?.merged && name !== 'exp/gpui-spike')
        throw new Error(`error: the branch '${name}' is not fully merged`)
      meta.branches = meta.branches.filter(([n]) => n !== name)
    },
    addWorktree(request, onStep) {
      // Like the Rust side: a second call for the same worktree while one runs joins it
      const key = `${request.repoPath}\0${request.pr ?? request.branch}`
      const running = steps.get(key)
      if (running) return running
      const call = addWorktree(request, onStep).finally(() => steps.delete(key))
      steps.set(key, call)
      return call
    },
    async removeWorktree(path, force, deleteBranch) {
      const checkout = CHECKOUTS.find((c) => c.path === path)
      const meta = checkout && REPOS[checkout.repoRoot]
      if (!checkout || !meta) throw new Error(`not a worktree: ${path}`)
      if (checkout.path === checkout.repoRoot) throw new Error('the main checkout cannot be removed')
      if (!force && localChanges(path).length) throw new Error(`fatal: '${path}' contains modified or untracked files, use --force to delete it`)
      CHECKOUTS.splice(CHECKOUTS.indexOf(checkout), 1)
      if (deleteBranch && checkout.branch) meta.branches = meta.branches.filter(([n]) => n !== checkout.branch)
      changed(checkout.repoRoot, [], true)
    },
    async pruneWorktrees(repoPath) {
      const meta = REPOS[repoPath]
      if (meta) meta.missing = []
    },
    async discardChanges(root, file) {
      const path = inside(root, file)
      edits.delete(path)
      discarded.add(path)
      changed(root, [file])
    },

    listFiles: async (root) => {
      const files = filesOf(root)
      const checkout = checkoutOf(root)
      return files && { files, ignored: checkout ? [...(REPOS[checkout.repoRoot]?.ignored ?? [])] : [] }
    },
    async listDirectory(root, folder) {
      const prefix = folder ? `${folder.replace(/\/$/, '')}/` : ''
      const checkout = checkoutOf(root)
      const names = new Set<string>()
      for (const path of [...(filesOf(root) ?? []), ...(checkout ? (REPOS[checkout.repoRoot]?.ignored ?? []) : [])]) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (rest) names.add(slash === -1 ? rest : rest.slice(0, slash + 1))
      }
      return [...names].sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
    },
    async readFile(root, file) {
      inside(root, file)
      if (BINARY.test(file)) return null
      return workingVersion(root, file)?.join('\n') ?? null
    },
    async saveFile(root, file, contents, expected) {
      inside(root, file)
      const current = workingVersion(root, file)?.join('\n') ?? null
      if (expected !== null && current !== expected) throw new Error(`${SAVE_CONFLICT}: ${file} changed on disk`)
      if (current !== null) snapshot(root, file, current)
      edits.set(`${root}/${file}`, contents)
      if (current === null) setOf(created, root).add(file)
      changed(root, [file])
    },
    async createPath(root, file) {
      inside(root, file)
      const clean = file.replace(/\/$/, '')
      if (filesOf(root)?.includes(clean)) throw new Error(`already exists: ${clean}`)
      if (file.endsWith('/')) setOf(created, root).add(`${clean}/.keep`)
      else {
        setOf(created, root).add(clean)
        edits.set(`${root}/${clean}`, '')
      }
      changed(root, [clean])
    },
    async renamePath(root, from, to) {
      inside(root, from)
      inside(root, to)
      const moved = (filesOf(root) ?? []).filter((f) => f === from || f.startsWith(`${from}/`))
      if (!moved.length) throw new Error(`no such file: ${from}`)
      for (const f of moved) {
        const target = to + f.slice(from.length)
        edits.set(`${root}/${target}`, workingVersion(root, f)?.join('\n') ?? '')
        setOf(created, root).add(target)
        setOf(trashed, root).add(f)
        setOf(created, root).delete(f)
      }
      changed(root, [from, to])
    },
    async trashPath(root, file) {
      inside(root, file)
      for (const f of (filesOf(root) ?? []).filter((f) => f === file || f.startsWith(`${file}/`))) setOf(trashed, root).add(f)
      changed(root, [file])
    },
    revealInFinder: async () => {},
    openPath: async () => {},
    async openUrl(url) {
      if (!/^https?:\/\//.test(url)) throw new Error(`refusing to open ${url}`)
      window.open(url, '_blank', 'noopener')
    },
    async searchText(roots, query, options) {
      if (!query) return { matches: [], truncated: false }
      const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi')
      const matches = []
      let truncated = false
      for (const root of roots)
        for (const path of filesOf(root) ?? []) {
          if (BINARY.test(path)) continue
          let perFile = 0
          for (const [i, text] of (workingVersion(root, path) ?? []).entries())
            for (const m of text.matchAll(pattern)) {
              if (matches.length >= 2000 || perFile >= 100) truncated = true
              else if (m[0]) {
                matches.push({ root, path, line: i + 1, column: m.index, length: m[0].length, text: text.slice(0, 400) })
                perFile++
              }
            }
        }
      return { matches, truncated }
    },
    watchFile(root, file, cb) {
      const key = `${root}\0${file}`
      const set = fileWatchers.get(key) ?? new Set()
      fileWatchers.set(key, set.add(cb))
      return () => void set.delete(cb)
    },
    watchPlace(root, cb) {
      const set = placeWatchers.get(root) ?? new Set()
      placeWatchers.set(root, set.add(cb))
      return () => void set.delete(cb)
    },

    listPullRequests: async (repoPaths) => ({ pullRequests: prs.filter((pr) => repoPaths.includes(pr.repoPath)).map((pr) => ({ ...pr })), errors: [] }),
    async prChecks(ref) {
      const pr = prs.find((p) => p.repoPath === ref.repoPath && p.number === ref.number)
      if (!pr) throw new Error(`no PR #${ref.number}`)
      const names = pr.provider === 'gitlab' ? ['build', 'lint', 'test:unit', 'test:e2e'] : CHECKS
      const failing = pr.number === 409 ? 'unit' : pr.number === 231 ? 'test:e2e' : null
      return names.map((name, i): Check => ({
        name,
        status: name === failing ? 'failed' : pr.pipeline?.status === 'running' && i >= (pr.pipeline.done ?? 0) ? 'running' : 'passed',
        url: `${pr.url}/checks?name=${encodeURIComponent(name)}`,
      }))
    },
    async mergePullRequest(ref) {
      const pr = prs.find((p) => p.repoPath === ref.repoPath && p.number === ref.number)
      if (!pr || pr.state !== 'open') throw new Error(`#${ref.number} is not open`)
      if (pr.pipeline?.status === 'failed') throw new Error('Required status check "unit" is failing')
      Object.assign(pr, { state: 'merged', review: null })
    },
    prProviders: async () => [
      { provider: 'github', installed: true, signedIn: true, user: 'you' },
      { provider: 'gitlab', installed: true, signedIn: true, user: 'you' },
    ],

    listHistory: async (root, file) => [...(snapshots.get(`${root}\0${file}`) ?? [])],
    async readHistory(root, file, id) {
      const text = snapshotText.get(`${root}\0${file}\0${id}`)
      if (text === undefined) throw new Error(`no such version: ${id}`)
      return text
    },
    sessionHistory: async () => records.map((r) => ({ ...r })),
    async forgetSession(id) {
      records = records.filter((r) => r.id !== id)
    },
  }
}
