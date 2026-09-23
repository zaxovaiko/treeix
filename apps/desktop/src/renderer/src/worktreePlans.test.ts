import { expect, test } from 'bun:test'
import type { Branch, Repo } from '../../shared/types'
import { cleanupCandidates, raceBranches } from './worktreePlans'

test('raceBranches names a worktree per agent only when several race', () => {
  expect(raceBranches('feat/x', [])).toEqual([{ branch: 'feat/x', session: null }])
  expect(raceBranches('feat/x', ['claude'])).toEqual([{ branch: 'feat/x', session: 'claude' }])
  expect(raceBranches('feat/x', ['claude', 'codex'])).toEqual([
    { branch: 'feat/x-claude', session: 'claude' },
    { branch: 'feat/x-codex', session: 'codex' }
  ])
})

test('cleanupCandidates offers finished worktrees, checking fresh merged and dirty ones off', () => {
  const now = 100 * 86_400
  const worktree = (name: string, changedFiles = 0) => ({ path: `/r/${name}`, head: 'abc', branch: name, changedFiles })
  const repo: Repo = { path: '/r/main', worktrees: [worktree('main'), worktree('gone'), worktree('fresh'), worktree('old', 2), worktree('live')] }
  const branch = (name: string, extra: Partial<Branch>, days = 0): Branch => ({ name, remote: false, ahead: 0, behind: 0, gone: false, merged: false, committedAt: now - days * 86_400, ...extra })
  const branches = new Map([['/r/main', [branch('main', {}), branch('gone', { gone: true }), branch('fresh', { merged: true }, 1), branch('old', {}, 40), branch('live', {}, 2)]]])
  expect(cleanupCandidates([repo], branches, now).map(({ worktree, reason, suggested }) => [worktree.branch, reason, suggested])).toEqual([
    ['gone', 'upstream gone', true],
    ['fresh', 'merged', false],
    ['old', 'no commits for 40 days', false]
  ])
})
