import { expect, test } from 'bun:test'
import type { PullRequest, SessionRecord } from '../ipc/api'
import { ago, ciText, dayLabel, isIgnored, needsYou, parseHunks, resumeCommand } from './logic'

test('parseHunks numbers old and new lines', () => {
  const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -2,3 +2,3 @@ fn', ' a', '-b', '+c', ' d', '\\ No newline at end of file', '@@ -10 +10,2 @@', '+e', ' f'].join('\n')
  const hunks = parseHunks(patch)
  expect(hunks.map((h) => h.header)).toEqual(['@@ -2,3 +2,3 @@ fn', '@@ -10 +10,2 @@'])
  expect(hunks[0].lines).toEqual([
    { kind: ' ', old: 2, new: 2, text: 'a' },
    { kind: '-', old: 3, new: null, text: 'b' },
    { kind: '+', old: null, new: 3, text: 'c' },
    { kind: ' ', old: 4, new: 4, text: 'd' },
  ])
  expect(hunks[1].lines.map((l) => [l.old, l.new])).toEqual([[null, 10], [10, 11]])
  expect(parseHunks('')).toEqual([])
})

test('isIgnored covers entries inside ignored folders', () => {
  const ignored = new Set(['node_modules/', '.env', 'dist/out/'])
  expect(isIgnored('node_modules/', ignored)).toBe(true)
  expect(isIgnored('node_modules/react/index.js', ignored)).toBe(true)
  expect(isIgnored('.env', ignored)).toBe(true)
  expect(isIgnored('dist/', ignored)).toBe(false)
  expect(isIgnored('dist/out/a.js', ignored)).toBe(true)
  expect(isIgnored('src/node_modules.ts', ignored)).toBe(false)
})

test('ago and dayLabel', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime()
  expect(ago(now - 30_000, now)).toBe('now')
  expect(ago(now - 5 * 60_000, now)).toBe('5m')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3h')
  expect(ago(now - 50 * 3_600_000, now)).toBe('2d')
  expect(dayLabel(new Date(2026, 9, 22, 1).getTime(), now)).toBe('Today')
  expect(dayLabel(new Date(2026, 9, 21, 23).getTime(), now)).toBe('Yesterday')
  expect(dayLabel(new Date(2026, 9, 18).getTime(), now)).not.toMatch(/Today|Yesterday/)
})

const pr = (over: Partial<PullRequest>): PullRequest => ({
  provider: 'github', repoPath: '/r', number: 1, title: 't', author: 'bob', authorAvatarUrl: null, sourceBranch: 'b', targetBranch: 'main', head: 'abc',
  state: 'open', draft: false, updatedAt: '2026-10-22T00:00:00Z', url: 'https://x', additions: 1, deletions: 1, changedFiles: 1, review: null, conflicts: false, pipeline: null, ...over,
})

test('needsYou: review requested, or mine with failing CI, only while open', () => {
  const failed = { status: 'failed' as const, done: 3, total: 3, url: '' }
  expect(needsYou(pr({ review: { state: 'requested', newCommits: 0, changesRequested: false } }), 'me')).toBe(true)
  expect(needsYou(pr({ author: 'me', pipeline: failed }), 'me')).toBe(true)
  expect(needsYou(pr({ author: 'bob', pipeline: failed }), 'me')).toBe(false)
  expect(needsYou(pr({ author: 'me', pipeline: failed, state: 'merged' }), 'me')).toBe(false)
  expect(ciText({ status: 'running', done: 2, total: 5, url: '' })).toBe('CI 2/5')
  expect(ciText(null)).toBe('No CI')
})

test('resumeCommand resumes agents by their session and reruns shells', () => {
  const r: SessionRecord = { id: 's', kind: 'claude', title: '', cwd: '/', branch: null, repoRoot: null, agentSession: 'abc', command: ['claude'], createdAt: 0, closedAt: 0, messages: null, cost: null, firstPrompt: null }
  expect(resumeCommand(r)).toEqual(['claude', '--resume', 'abc'])
  expect(resumeCommand(r, true)).toEqual(['claude', '--resume', 'abc', '--fork-session'])
  expect(resumeCommand({ ...r, kind: 'codex' })).toEqual(['codex', 'resume', 'abc'])
  expect(resumeCommand({ ...r, agentSession: null })).toBeUndefined()
  expect(resumeCommand({ ...r, kind: 'shell', agentSession: null, command: ['htop'] })).toEqual(['htop'])
})
