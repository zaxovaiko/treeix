import { expect, test } from 'bun:test'
import type { Branch, GitStatus, SearchMatch, Worktree } from '../ipc/api'
import { branchCheck, branchRows, cleanable, groupMatches, removeWarnings, rowState, setupCommand, splitMatch, worktreeDir, type WorktreeRow } from './logic'
import { patchRows, versionRows } from './diffRows'

const REPO = '/r/app'
const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({ name, remote: false, ahead: 0, behind: 0, gone: false, merged: false, committedAt: 0, author: 'ana', worktree: null, ...extra })
const wt = (path: string, name: string | null, extra: Partial<Worktree> = {}): Worktree => ({ path, head: 'abc1234', branch: name, main: false, missing: false, ...extra })
const status = (extra: Partial<GitStatus> = {}): GitStatus => ({ branch: 'x', head: 'abc', upstream: 'origin/x', ahead: 0, behind: 0, gone: false, base: 'main', baseAhead: 0, merged: false, rebase: null, conflicts: [], changes: [], ...extra })

const branches = [branch('main'), branch('feat/a'), branch('origin/feat/b', { remote: true, author: 'bo', committedAt: 0 }), branch('origin/main', { remote: true })]
const worktrees = [wt(REPO, 'main', { main: true }), wt(`${REPO}/.claude/worktrees/feat+a`, 'feat/a'), wt(`${REPO}/.claude/worktrees/old`, 'old', { missing: true })]

test('worktree dir and setup command', () => {
  expect(worktreeDir('feat/a/b')).toBe('.claude/worktrees/feat+a+b')
  expect(setupCommand(['README.md', 'yarn.lock', 'pnpm-lock.yaml'])).toBe('pnpm install')
  expect(setupCommand(['Cargo.toml'])).toBeNull()
})

test('branch rows offer create first, hide origin twins, strip origin/', () => {
  const ctx = { repoPath: REPO, branches, worktrees, open: new Set([`${REPO}/.claude/worktrees/feat+a`]), prs: [] }
  expect(branchRows(ctx, '', 3600_000).map((r) => [r.name, r.detail])).toEqual([
    ['main', 'repo folder'],
    ['feat/a', 'worktree · open'],
    ['feat/b', 'origin · bo · 1h'],
  ])
  const typed = branchRows(ctx, 'feat')
  expect(typed[0]).toMatchObject({ name: 'feat', create: true })
  expect(typed.map((r) => r.name)).toEqual(['feat', 'feat/a', 'feat/b'])
  expect(branchRows(ctx, 'feat/b').some((r) => r.create)).toBe(false)
})

test('branch check', () => {
  const input = { repoPath: REPO, branches, worktrees, valid: true, hasCommits: true, repoName: 'app' }
  expect(branchCheck({ ...input, name: 'x', hasCommits: false })?.level).toBe('err')
  expect(branchCheck({ ...input, name: 'a..b', valid: false })?.level).toBe('err')
  expect(branchCheck({ ...input, name: 'old' })).toMatchObject({ level: 'err', worktree: { branch: 'old' } })
  expect(branchCheck({ ...input, name: 'feat/a' })).toMatchObject({ level: 'go', text: 'feat/a is already open in .claude/worktrees/feat+a' })
  expect(branchCheck({ ...input, name: 'main' })?.text).toContain('the repo folder')
  expect(branchCheck({ ...input, name: 'feat/b' })?.text).toContain('only on origin')
  expect(branchCheck({ ...input, name: 'new' })).toBeNull()
})

const row = (extra: Partial<WorktreeRow> = {}): WorktreeRow => ({ repoPath: REPO, worktree: wt(`${REPO}/w`, 'x'), status: status(), pr: null, sessions: 0, ...extra })

test('row state and what cleanup preselects', () => {
  expect(rowState(row({ worktree: wt(`${REPO}/w`, 'x', { missing: true }) }))?.label).toBe('missing')
  expect(rowState(row({ status: status({ rebase: { step: 1, total: 5 }, merged: true }) }))?.label).toBe('rebasing')
  expect(rowState(row({ status: status({ merged: true }) }))?.tone).toBe('violet')
  expect(rowState(row({ worktree: wt(REPO, 'main', { main: true }), status: status({ branch: 'main' }) }))).toBeNull()
  expect(rowState(row({ worktree: wt(`${REPO}/w`, null) }))?.label).toBe('detached')
  expect(cleanable(row({ status: status({ gone: true }) }))).toBe(true)
  expect(cleanable(row())).toBe(false)
  expect(cleanable(row({ worktree: wt(REPO, 'main', { main: true }), status: status({ merged: true }) }))).toBe(false)
})

test('remove warnings', () => {
  const dirty = removeWarnings(row({ sessions: 2, status: status({ ahead: 3, changes: [{ path: 'a', status: 'modified', oldPath: null }] }) }))
  expect(dirty.map(([level]) => level)).toEqual(['err', 'warn', '', ''])
  expect(dirty[0][1]).toBe('1 uncommitted file is deleted with the folder')
  expect(removeWarnings(row({ status: status({ upstream: null, baseAhead: 2 }) }))[0]).toEqual(['err', '2 commits were never pushed. The branch keeps them.'])
  expect(removeWarnings(row({ status: status({ merged: true }) })).at(-1)?.[1]).toBe('The merged branch x is deleted')
})

test('matches group by file and split around the hit', () => {
  const m = (path: string, line: number): SearchMatch => ({ root: REPO, path, line, column: 4, length: 3, text: 'let foo = 1' })
  const groups = groupMatches([m('a.ts', 1), m('b.ts', 2), m('a.ts', 9)])
  expect(groups.map((g) => [g.path, g.matches.map((x) => x.line)])).toEqual([
    ['a.ts', [1, 9]],
    ['b.ts', [2]],
  ])
  expect(splitMatch(m('a.ts', 1))).toEqual(['let ', 'foo', ' = 1'])
})

test('diff rows from a patch and from two versions', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
  expect(patchRows(patch)).toEqual([
    { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
    { kind: 'ctx', text: 'keep' },
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
  ])
  expect(patchRows('')).toEqual([])
  expect(versionRows('x', 'a\nb\n', 'a\nc\n').filter((r) => r.kind !== 'ctx' && r.kind !== 'hunk')).toEqual([
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'c' },
  ])
})
