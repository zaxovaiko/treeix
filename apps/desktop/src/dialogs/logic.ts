import type { Branch, GitStatus, PullRequest, SearchMatch, Worktree } from '../ipc/api'

// Pure helpers behind the dialogs: the branch picker and its live check, the Worktrees rows, Find in files grouping

/** Where `addWorktree` puts a branch, relative to the repo (contract: `/` becomes `+`) */
export const worktreeDir = (branch: string) => `.claude/worktrees/${branch.replaceAll('/', '+')}`
export const prDir = (pr: number, gitlab: boolean) => `.claude/worktrees/${gitlab ? 'mr' : 'pr'}-${pr}`

const SETUP: [lockfile: string, command: string][] = [
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['pnpm-lock.yaml', 'pnpm install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
]

/** The install command a fresh worktree needs, from the lockfile in the repo folder */
export const setupCommand = (names: string[]): string | null => SETUP.find(([lock]) => names.includes(lock))?.[1] ?? null

const ORIGIN = 'origin/'
/** `origin/feat/x` is offered as `feat/x`: picking it creates a local branch tracking it */
export const localName = (branch: string) => (branch.startsWith(ORIGIN) ? branch.slice(ORIGIN.length) : branch)

export interface BranchRow {
  name: string
  /** "Create <name>" */
  create: boolean
  remote: boolean
  detail: string
  pr: number | null
  /** Checked out in a worktree whose folder is gone */
  missing: boolean
}

export interface BranchContext {
  repoPath: string
  branches: Branch[]
  worktrees: Worktree[]
  /** Worktree paths with a tab open */
  open: Set<string>
  prs: PullRequest[]
}

const ago = (seconds: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - seconds * 1000) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  if (minutes < 60 * 24 * 14) return `${Math.round(minutes / 60 / 24)}d`
  return `${Math.round(minutes / 60 / 24 / 7)}w`
}

/** What the branch field suggests: create the typed name, local branches with where they are open, origin-only ones */
export function branchRows(ctx: BranchContext, query: string, now = Date.now()): BranchRow[] {
  const q = query.trim()
  const names = new Set(ctx.branches.map((b) => localName(b.name)))
  const rows: BranchRow[] = []
  if (q && !names.has(q)) rows.push({ name: q, create: true, remote: false, detail: '', pr: null, missing: false })
  for (const b of ctx.branches) {
    const name = localName(b.name)
    if (q && !name.toLowerCase().includes(q.toLowerCase())) continue
    if (b.remote && ctx.branches.some((x) => !x.remote && x.name === name)) continue
    const wt = ctx.worktrees.find((w) => w.branch === name)
    const pr = ctx.prs.find((p) => p.state === 'open' && p.sourceBranch === name)?.number ?? null
    const detail = b.remote
      ? `origin · ${b.author} · ${ago(b.committedAt, now)}`
      : wt?.missing
        ? 'folder gone'
        : wt?.path === ctx.repoPath
          ? 'repo folder'
          : wt
            ? `worktree${ctx.open.has(wt.path) ? ' · open' : ''}`
            : 'local'
    rows.push({ name, create: false, remote: b.remote, detail, pr, missing: !!wt?.missing })
  }
  return rows
}

export type CheckLevel = 'err' | 'info' | 'go' | 'hint'

export interface BranchCheck {
  level: CheckLevel
  text: string
  /** The worktree the branch is open in, or the missing one to prune */
  worktree: Worktree | null
}

export interface CheckInput extends Pick<BranchContext, 'repoPath' | 'branches' | 'worktrees'> {
  name: string
  /** `checkBranchName`; null while it runs */
  valid: boolean | null
  /** False before the first commit */
  hasCommits: boolean
  repoName: string
}

/** Null when the name is fine to create; the dialog shows anything else under the field */
export function branchCheck(input: CheckInput): BranchCheck | null {
  const { name, repoPath, repoName } = input
  const at = (level: CheckLevel, text: string, worktree: Worktree | null = null): BranchCheck => ({ level, text, worktree })
  if (!input.hasCommits) return at('err', `${repoName} has no commits yet. Commit once, then branch off it.`)
  if (!name) return at('hint', 'Pick a branch or name a new one')
  if (input.valid === false) return at('err', `"${name}" is not a valid branch name`)
  const used = input.worktrees.find((w) => w.branch === name)
  if (used?.missing) return at('err', `${name} is checked out in a worktree whose folder is gone`, used)
  if (used) return at('go', `${name} is already open in ${used.path === repoPath ? 'the repo folder' : used.path.slice(repoPath.length + 1)}`, used)
  if (input.branches.some((b) => !b.remote && b.name === name)) return at('info', `${name} exists: it is checked out, not created`)
  if (input.branches.some((b) => b.remote && localName(b.name) === name)) return at('info', `${name} is only on origin: a local branch tracking origin/${name} is created`)
  return null
}

/** Rows of the Worktrees dialog: one per worktree of a repo */
export interface WorktreeRow {
  repoPath: string
  worktree: Worktree
  status: GitStatus | null
  /** Open PR from its branch, or the PR a detached `pr-N` checkout was made for */
  pr: PullRequest | null
  sessions: number
}

export type Tone = 'red' | 'violet' | 'plain'

/** Same order as the sidebar: what blocks you first, then whether the branch landed */
export function rowState({ worktree, status, pr }: WorktreeRow): { label: string; tone: Tone } | null {
  if (worktree.missing) return { label: 'missing', tone: 'red' }
  if (status?.rebase) return { label: 'rebasing', tone: 'red' }
  if (status?.merged) return { label: 'merged', tone: 'violet' }
  if (pr) return { label: `#${pr.number} open`, tone: 'plain' }
  if (!worktree.branch) return { label: 'detached', tone: 'plain' }
  if (worktree.main && worktree.branch === status?.base) return null
  return { label: 'not merged', tone: 'plain' }
}

/** Preselected by "Select merged and gone" */
export const cleanable = ({ worktree, status }: WorktreeRow) => !worktree.main && (worktree.missing || !!status?.merged || !!status?.gone)

export type Warning = ['err' | 'warn' | '', string]

/** What removing throws away, said before it happens */
export function removeWarnings({ worktree, status, sessions }: WorktreeRow): Warning[] {
  if (worktree.missing) return [['', 'The folder is gone: git forgets the worktree']]
  const out: Warning[] = []
  const changes = status?.changes.length ?? 0
  if (changes) out.push(['err', `${changes} uncommitted ${changes > 1 ? 'files are' : 'file is'} deleted with the folder`])
  const ahead = status?.ahead ?? 0
  if (status && !status.upstream && status.baseAhead && !status.merged) out.push(['err', `${status.baseAhead} commits were never pushed. The branch keeps them.`])
  else if (ahead) out.push(['warn', `${ahead} commits not pushed yet. The branch keeps them.`])
  if (sessions) out.push(['', `${sessions} ${sessions > 1 ? 'sessions close' : 'session closes'}`])
  if (status?.merged || status?.gone) out.push(['', `The ${status.merged ? 'merged' : 'gone'} branch ${worktree.branch ?? ''} is deleted`])
  else out.push(['', worktree.branch ? `Branch ${worktree.branch} stays, so the worktree can be recreated` : 'Detached HEAD: nothing to keep'])
  return out
}

export interface FileHits {
  root: string
  path: string
  matches: SearchMatch[]
}

/** Matches grouped by file, in the order they came */
export function groupMatches(matches: SearchMatch[]): FileHits[] {
  const byFile = new Map<string, FileHits>()
  for (const m of matches) {
    const key = `${m.root}\0${m.path}`
    const group = byFile.get(key) ?? { root: m.root, path: m.path, matches: [] }
    group.matches.push(m)
    byFile.set(key, group)
  }
  return [...byFile.values()]
}

/** The line split around the match; column and length are UTF-16 units, like JS strings */
export const splitMatch = ({ text, column, length }: SearchMatch): [string, string, string] => [text.slice(0, column), text.slice(column, column + length), text.slice(column + length)]

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
