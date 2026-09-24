import { execFile } from 'node:child_process'
import { readdir, readFile as readFileBytes, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Branch, CodeLocation, FilePatch, SearchMatch, SearchOptions, SearchResult, Repo, Worktree, WorktreeFiles } from '../shared/types'

const exec = promisify(execFile)
const MAX_DEPTH = 6
// macOS privacy-protected dirs block on permission prompts, skip them
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'Library',
  'Applications',
  'Pictures',
  'Music',
  'Movies',
  'Public'
])
const MAX_UNTRACKED_PATCHES = 200
const MAX_VIEW_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 500
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

async function git(cwd: string, args: string[], okExitCodes = [0]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (error: unknown) {
    if (isExecError(error) && okExitCodes.includes(error.code)) return error.stdout
    throw error
  }
}

function isExecError(error: unknown): error is { code: number; stdout: string } {
  return typeof error === 'object' && error !== null && 'code' in error && 'stdout' in error
}

// ponytail: plain fs walk of ~, swap for mdfind if scans get slow
export async function findRepos(root = homedir(), depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  if (entries.some((entry) => entry.name === '.git' && entry.isDirectory())) return [root]
  const children = entries.filter(
    (entry) =>
      entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)
  )
  const nested = await Promise.all(children.map((entry) => findRepos(join(root, entry.name), depth + 1)))
  return nested.flat()
}

export function parseWorktreeList(porcelain: string): Omit<Worktree, 'changedFiles'>[] {
  return porcelain
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('worktree '))
    .filter((block) => !block.split('\n').includes('bare'))
    .map((block) => {
      const fields = new Map(
        block.split('\n').map((line) => {
          const space = line.indexOf(' ')
          return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
        })
      )
      const branch = fields.get('branch')
      return {
        path: fields.get('worktree') ?? '',
        head: (fields.get('HEAD') ?? '').slice(0, 7),
        branch: branch ? branch.replace('refs/heads/', '') : null
      }
    })
}

async function countChanges(worktreePath: string): Promise<number> {
  const status = await git(worktreePath, ['status', '--porcelain']).catch(() => '')
  return status.split('\n').filter(Boolean).length
}

export async function scan(): Promise<Repo[]> {
  const repoPaths = await findRepos()
  const repos = await Promise.all(
    repoPaths.map(async (path) => {
      const list = await git(path, ['worktree', 'list', '--porcelain']).catch(() => '')
      const worktrees = await Promise.all(
        parseWorktreeList(list).map(async (worktree) => ({
          ...worktree,
          changedFiles: await countChanges(worktree.path)
        }))
      )
      return { path, worktrees }
    })
  )
  return repos.filter((repo) => repo.worktrees.length > 0)
}

export function splitPatch(patch: string): FilePatch[] {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const hunkStart = chunk.indexOf('\n@@')
      const hunks = hunkStart === -1 ? '' : chunk.slice(hunkStart)
      return {
        path: chunk.match(/^diff --git a\/.+? b\/(.+)$/m)?.[1] ?? '',
        patch: chunk,
        additions: hunks.match(/^\+/gm)?.length ?? 0,
        deletions: hunks.match(/^-/gm)?.length ?? 0
      }
    })
}

export async function diff(worktreePath: string): Promise<FilePatch[]> {
  const hasHead = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false
  )
  const tracked = hasHead ? await git(worktreePath, ['diff', 'HEAD', '--no-color']) : ''
  const untrackedList = await git(worktreePath, ['ls-files', '--others', '--exclude-standard'])
  const untracked = await Promise.all(
    untrackedList
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_PATCHES)
      .map((file) => git(worktreePath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], [0, 1]))
  )
  return splitPatch([tracked, ...untracked].join('\n'))
}

const lines = (output: string): string[] => [...new Set(output.split('\n').filter(Boolean))].sort()

export async function listFiles(worktreePath: string): Promise<WorktreeFiles> {
  const [files, ignored] = await Promise.all([
    git(worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard']),
    git(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
  ])
  return { files: lines(files), ignored: lines(ignored) }
}

export async function readFile(worktreePath: string, filePath: string): Promise<string | null> {
  const absolute = resolve(worktreePath, filePath)
  const insideWorktree = !relative(worktreePath, absolute).startsWith('..')
  if (!insideWorktree || (await stat(absolute)).size > MAX_VIEW_BYTES) return null
  const bytes = await readFileBytes(absolute)
  return bytes.includes(0) ? null : bytes.toString('utf8')
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }

/** Image type of a path by its extension; SVG is text and opens as code */
export const imageType = (filePath: string): string | null => IMAGE_TYPES[filePath.split('.').pop()?.toLowerCase() ?? ''] ?? null

/** A picture in the worktree as a data URL, for showing it; null when it is not an image, outside the worktree or too big */
export async function readImage(worktreePath: string, filePath: string): Promise<string | null> {
  const absolute = resolve(worktreePath, filePath)
  const type = imageType(filePath)
  if (!type || relative(worktreePath, absolute).startsWith('..') || (await stat(absolute)).size > MAX_IMAGE_BYTES) return null
  return `data:${type};base64,${(await readFileBytes(absolute)).toString('base64')}`
}

const escapeRegExp = (text: string): string => text.replace(/[$]/g, '\\$')

// ponytail: regex guesses, swap for a language server if jumps get unreliable
export function isDefinitionLine(line: string, symbol: string): boolean {
  const name = escapeRegExp(symbol)
  const modifiers = '(?:(?:export|default|public|private|protected|static|async|override|readonly|abstract|pub(?:\\([^)]*\\))?)\\s+)*'
  return [
    new RegExp(`\\b(?:function\\*?|class|interface|type|enum|def|fn|struct|trait|const|let|var|val|namespace|module|macro_rules!)\\s+${name}\\b`),
    new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${name}\\b`),
    new RegExp(`^\\s*${modifiers}${name}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\{\\s*$`),
    new RegExp(`^\\s*${modifiers}${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*(?::[^=]+)?=>`)
  ].some((pattern) => pattern.test(line))
}

async function grepSymbol(worktreePath: string, symbol: string, keep: (text: string) => boolean): Promise<CodeLocation[]> {
  if (!IDENTIFIER.test(symbol)) return []
  const output = await git(worktreePath, ['grep', '-n', '-I', '-w', '-F', '--untracked', '-e', symbol], [0, 1])
  const locations: CodeLocation[] = []
  for (const row of output.split('\n')) {
    const match = row.match(/^(.+?):(\d+):(.*)$/)
    if (!match || !keep(match[3])) continue
    const column = Math.max(0, match[3].search(new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`)))
    locations.push({ path: match[1], line: Number(match[2]), column, text: match[3].trim() })
    if (locations.length === MAX_MATCHES) break
  }
  return locations
}

export const findDefinitions = (worktreePath: string, symbol: string): Promise<CodeLocation[]> =>
  grepSymbol(worktreePath, symbol, (text) => isDefinitionLine(text, symbol))

/** Whole-word text matches, for languages without a language service */
export const findTextReferences = (worktreePath: string, symbol: string): Promise<CodeLocation[]> => grepSymbol(worktreePath, symbol, () => true)

const MAX_SEARCH_MATCHES = 2000
const MAX_MATCHES_PER_FILE = 100
const MAX_LINE_CHARS = 400

/** Project-wide text search, like VS Code's ⇧⌘F; tracked and untracked files, gitignore respected */
export async function searchText(worktreePaths: string[], query: string, options: SearchOptions): Promise<SearchResult> {
  if (!query) return { matches: [], truncated: false }
  const flags = [
    '-n',
    '--column',
    '-I',
    '--untracked',
    '--no-color',
    '--full-name',
    `--max-count=${MAX_MATCHES_PER_FILE}`,
    options.regex ? '-E' : '-F',
    ...(options.caseSensitive ? [] : ['-i']),
    ...(options.wholeWord ? ['-w'] : [])
  ]
  const matches: SearchMatch[] = []
  for (const worktreePath of worktreePaths) {
    // -z separates path, line and column with NUL so paths containing colons parse correctly
    const output = await git(worktreePath, ['grep', '-z', ...flags, '-e', query], [0, 1]).catch((error: unknown) => {
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
      throw new Error(stderr.replace(/^fatal: /, '') || 'Search failed')
    })
    for (const row of output.split('\n')) {
      const [path, line, column, ...rest] = row.split('\0')
      if (!path || !line || !column) continue
      matches.push({ worktreePath, path, line: Number(line), column: Number(column) - 1, text: rest.join('\0').slice(0, MAX_LINE_CHARS) })
      if (matches.length === MAX_SEARCH_MATCHES) return { matches, truncated: true }
    }
  }
  return { matches, truncated: false }
}

/** Worktree folder per the `.claude/worktrees/<branch with + for />` convention */
export const worktreeDir = (repoPath: string, branch: string): string => join(repoPath, '.claude', 'worktrees', branch.replaceAll('/', '+'))

const succeeds = (cwd: string, args: string[]): Promise<boolean> =>
  git(cwd, args).then(
    () => true,
    () => false
  )

const BRANCH_FORMAT = '%(refname)%00%(upstream:track,nobracket)%00%(committerdate:unix)'

/** "ahead 2, behind 3" or "gone" from for-each-ref's upstream:track */
export function parseTrack(track: string): Pick<Branch, 'ahead' | 'behind' | 'gone'> {
  return {
    ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
    gone: track === 'gone'
  }
}

async function defaultBranch(repoPath: string): Promise<string | null> {
  const remoteHead = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], [0, 1]).catch(() => '')).trim()
  if (remoteHead) return remoteHead
  for (const candidate of ['main', 'master', 'dev']) {
    if (await succeeds(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) return candidate
  }
  return null
}

export async function listBranches(repoPath: string): Promise<Branch[]> {
  const base = await defaultBranch(repoPath)
  const [refs, merged] = await Promise.all([
    git(repoPath, ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']),
    base ? git(repoPath, ['for-each-ref', '--merged', base, '--format=%(refname)', 'refs/heads']).catch(() => '') : Promise.resolve('')
  ])
  // The default branch itself is never "merged", whether base is main or origin/main
  const baseName = base?.replace(/^origin\//, '')
  const mergedRefs = new Set(merged.split('\n').filter(Boolean))
  const rows = refs.split('\n').filter(Boolean).map((row) => row.split('\0'))
  const localNames = new Set(rows.filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref]) => ref.slice('refs/heads/'.length)))
  const branches: Branch[] = []
  for (const [ref, track = '', committedAt = '0'] of rows) {
    const remote = ref.startsWith('refs/remotes/')
    const name = ref.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length)
    // origin/HEAD is an alias, and remote branches that also exist locally would show twice
    if (remote && (name.endsWith('/HEAD') || localNames.has(name.slice(name.indexOf('/') + 1)))) continue
    branches.push({ name, remote, ...parseTrack(track), merged: !remote && mergedRefs.has(ref) && name !== baseName, committedAt: Number(committedAt) })
  }
  return branches
}

export async function createBranch(repoPath: string, name: string, base: string): Promise<void> {
  const checked = (await git(repoPath, ['check-ref-format', '--branch', name]).catch(() => '')).trim()
  if (!checked || checked.startsWith('-')) throw new Error(`"${name}" is not a valid branch name`)
  if (base.startsWith('-')) throw new Error(`"${base}" is not a valid base`)
  await git(repoPath, ['branch', '--no-track', checked, base])
}

export async function deleteBranch(repoPath: string, name: string): Promise<void> {
  if (name.startsWith('-')) throw new Error(`"${name}" is not a valid branch name`)
  await git(repoPath, ['branch', '-d', name])
}

/** Creates in flight, by repository and branch: a second click before the list refreshes gets the same worktree */
const addingWorktrees = new Map<string, Promise<string>>()

/** Checks out an existing local or remote branch, or creates it from `base` (HEAD when omitted); a branch that already has a worktree gets that one */
export function addWorktree(repoPath: string, branch: string, base?: string): Promise<string> {
  const key = `${repoPath}\0${branch}`
  const pending = addingWorktrees.get(key) ?? createWorktree(repoPath, branch, base).finally(() => addingWorktrees.delete(key))
  addingWorktrees.set(key, pending)
  return pending
}

async function createWorktree(repoPath: string, branch: string, base?: string): Promise<string> {
  const name = (await git(repoPath, ['check-ref-format', '--branch', branch]).catch(() => '')).trim()
  if (!name || name.startsWith('-')) throw new Error(`"${branch}" is not a valid branch name`)
  const existing = parseWorktreeList(await git(repoPath, ['worktree', 'list', '--porcelain'])).find((worktree) => worktree.branch === name)
  if (existing) return existing.path
  const path = worktreeDir(repoPath, name)
  if (base?.startsWith('-')) throw new Error(`"${base}" is not a valid base`)
  if (await succeeds(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) {
    await git(repoPath, ['worktree', 'add', path, name])
  } else {
    await git(repoPath, ['fetch', 'origin', name]).catch(() => '')
    const onRemote = await succeeds(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`])
    await git(repoPath, ['worktree', 'add', ...(onRemote ? ['--track', '-b', name, path, `origin/${name}`] : ['-b', name, path, ...(base ? [base] : [])])])
  }
  return path
}

async function mainWorktreeOf(worktreePath: string): Promise<string> {
  const commonDir = (await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  return dirname(commonDir)
}

export async function removeWorktree(worktreePath: string, force: boolean): Promise<void> {
  const main = await mainWorktreeOf(worktreePath)
  if (resolve(main) === resolve(worktreePath)) throw new Error('The main worktree cannot be removed')
  await git(main, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath])
}

/** Restores a tracked file to HEAD or deletes an untracked one */
export async function discardChanges(worktreePath: string, filePath: string): Promise<void> {
  const absolute = resolve(worktreePath, filePath)
  if (relative(worktreePath, absolute).startsWith('..')) throw new Error('File is outside the worktree')
  const tracked = await succeeds(worktreePath, ['ls-files', '--error-unmatch', '--', filePath])
  if (tracked) await git(worktreePath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath])
  else await git(worktreePath, ['clean', '-f', '--', filePath])
}
