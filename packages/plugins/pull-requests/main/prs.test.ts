import { expect, test } from 'bun:test'
import { splitPatch } from '@treeix/host/git'
import { githubFilesToPatches, githubReviewers, githubReviewStatuses, githubThreadStates, githubThreads, gitlabReviewers, gitlabThreads, normalizeGitlabDiff, parseMergeTreeConflicts, parseRemote, toGithubPullRequest, toGitlabPullRequest, githubMyReview } from './prs'

test('parseRemote', () => {
  expect(parseRemote('git@github.com:blurifycom/openora.git')).toEqual({ provider: 'github', host: 'github.com', slug: 'blurifycom/openora' })
  expect(parseRemote('https://github.com/a/b')).toEqual({ provider: 'github', host: 'github.com', slug: 'a/b' })
  expect(parseRemote('ssh://git@gitlab.blurify.com:2222/betfeel/sub/betfeel.git\n')).toEqual({
    provider: 'gitlab',
    host: 'gitlab.blurify.com',
    slug: 'betfeel/sub/betfeel'
  })
  expect(parseRemote('git@bitbucket.org:a/b.git')).toBeNull()
})

test('normalizeGitlabDiff', () => {
  const diff = `--- apps/a.ts
+++ apps/a.ts
@@ -1 +1 @@
-x
+y
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+z`
  const patches = splitPatch(normalizeGitlabDiff(diff))
  expect(patches.map(({ path, additions, deletions }) => [path, additions, deletions])).toEqual([
    ['apps/a.ts', 1, 1],
    ['new.ts', 1, 0]
  ])
  expect(patches[1].patch).toContain('--- /dev/null\n+++ b/new.ts')
  const gitFormatted = 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n'
  expect(normalizeGitlabDiff(gitFormatted)).toBe(gitFormatted)
})

test('githubThreads groups replies under their root comment', () => {
  const threads = githubThreads(
    [
      { id: 1, path: 'a.ts', line: 4, side: 'RIGHT', body: 'why?', user: { login: 'kasia' }, created_at: 't1' },
      { id: 2, in_reply_to_id: 1, path: 'a.ts', line: 4, body: 'because', user: { login: 'me' }, created_at: 't2' },
      { id: 3, path: 'b.ts', line: null, original_line: 9, side: 'LEFT', body: 'old', user: { login: 'bot' } }
    ],
    [{ id: 9, user: { login: 'lead', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, body: 'lgtm', created_at: 't0', reactions: { '+1': 2 } }]
  )
  expect(threads.map((thread) => [thread.path, thread.line, thread.side, thread.comments.map((c) => c.author)])).toEqual([
    [null, null, 'additions', ['lead']],
    ['a.ts', 4, 'additions', ['kasia', 'me']],
    ['b.ts', 9, 'deletions', ['bot']]
  ])
  expect(threads[0].comments[0].id).toBe('issue:9')
  expect(threads[0].comments[0].avatarUrl).toBe('https://avatars.githubusercontent.com/u/1')
  expect(threads[1].comments[0].avatarUrl).toBeNull()
  expect(threads[0].comments[0].reactions['+1']).toBe(2)
  expect(threads[1].comments[1].id).toBe('review:2')
})

test('gitlabThreads skips system notes and maps positions', () => {
  const threads = gitlabThreads([
    { id: 'd1', notes: [{ system: true, body: 'changed the description', author: { username: 'x' } }] },
    {
      id: 'd2',
      notes: [{ body: 'rename', author: { username: 'kasia' }, position: { new_path: 'a.ts', new_line: 3 } }]
    },
    { id: 'd3', notes: [{ body: 'removed?', author: { username: 'kasia' }, position: { old_path: 'b.ts', new_line: null, old_line: 7 } }] },
    { id: 'd4', notes: [{ body: 'general', author: { username: 'lead' } }] }
  ])
  expect(threads.map((thread) => [thread.id, thread.path, thread.line, thread.side])).toEqual([
    ['d2', 'a.ts', 3, 'additions'],
    ['d3', 'b.ts', 7, 'deletions'],
    ['d4', null, null, 'additions']
  ])
})

test('toGitlabPullRequest maps states', () => {
  const pr = toGitlabPullRequest({ iid: 427, state: 'opened', draft: true, author: { username: 'o' } }, '/repo')
  expect([pr.number, pr.state, pr.draft, pr.author]).toEqual([427, 'open', true, 'o'])
  expect(toGithubPullRequest({ author: { login: 'zaxovaiko' } }, '/repo').authorAvatarUrl).toBe('https://github.com/zaxovaiko.png?size=64')
  expect(toGithubPullRequest({ author: { login: 'app/dependabot' } }, '/repo').authorAvatarUrl).toBeNull()
})

test('githubFilesToPatches rebuilds headers from the files API', () => {
  const [added, renamed] = githubFilesToPatches([
    { filename: 'new.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' },
    { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', additions: 0, deletions: 0 }
  ])
  expect(added.patch).toBe('diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n')
  expect(splitPatch(added.patch)[0].additions).toBe(1)
  expect(renamed.patch).toBe('diff --git a/a.ts b/b.ts\n--- a/a.ts\n+++ b/b.ts\n')
})

test('githubReviewStatuses tells reviewed, requested and own PRs apart', () => {
  const pr = (number: number, author: string, requested: string[], reviews: [string, string, string][], commits: string[]) => ({
    number,
    author: { login: author },
    reviewRequests: { nodes: requested.map((login) => ({ requestedReviewer: { login } })) },
    latestReviews: { nodes: reviews.map(([login, state, oid]) => ({ author: { login }, state, commit: { oid } })) },
    commits: { nodes: commits.map((oid) => ({ commit: { oid } })) }
  })
  const statuses = githubReviewStatuses({
    data: {
      viewer: { login: 'me' },
      search: {
        nodes: [
          pr(1, 'me', [], [], ['a']),
          pr(2, 'ann', ['me'], [], ['a']),
          pr(3, 'ann', [], [['me', 'APPROVED', 'b'], ['bob', 'CHANGES_REQUESTED', 'b']], ['a', 'b']),
          pr(4, 'ann', [], [['me', 'CHANGES_REQUESTED', 'a']], ['a', 'b', 'c']),
          pr(5, 'ann', [], [], ['a']),
          pr(6, 'me', [], [['ann', 'APPROVED', 'a'], ['bob', 'CHANGES_REQUESTED', 'a']], ['a', 'b']),
          {}
        ]
      }
    }
  })
  expect(Object.fromEntries(statuses)).toEqual({
    1: { state: 'yours', newCommits: 0 },
    2: { state: 'requested', newCommits: 0 },
    3: { state: 'approved', newCommits: 0, changesRequested: true },
    4: { state: 'changes', newCommits: 2 },
    5: { state: 'unreviewed', newCommits: 0 },
    6: { state: 'yours', newCommits: 0, changesRequested: true }
  })
})

test('githubThreadStates maps review threads to their root comment', () => {
  const states = githubThreadStates({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { id: 'T1', isResolved: true, comments: { nodes: [{ databaseId: 11 }] } },
              { id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 22 }] } },
              { id: 'T3', isResolved: false, comments: { nodes: [] } }
            ]
          }
        }
      }
    }
  })
  expect(Object.fromEntries(states)).toEqual({ 11: { resolveId: 'T1', resolved: true }, 22: { resolveId: 'T2', resolved: false } })
  const [thread] = githubThreads([{ id: 11, path: 'a.ts', line: 3, side: 'RIGHT', body: 'x', user: { login: 'ann' } }], [], states)
  expect([thread.resolved, thread.resolveId]).toEqual([true, 'T1'])
})

test('githubReviewers lists pending requests first and skips the author', () => {
  const reviewers = githubReviewers({
    data: {
      repository: {
        pullRequest: {
          author: { login: 'ann' },
          reviewRequests: { nodes: [{ requestedReviewer: { login: 'bob', avatarUrl: 'b.png' } }, { requestedReviewer: {} }] },
          latestReviews: {
            nodes: [
              { author: { login: 'cid', avatarUrl: '' }, state: 'CHANGES_REQUESTED' },
              { author: { login: 'ann' }, state: 'COMMENTED' },
              { author: { login: 'bob' }, state: 'APPROVED' }
            ]
          }
        }
      }
    }
  })
  expect(reviewers).toEqual([
    { login: 'bob', avatarUrl: 'b.png', state: 'requested' },
    { login: 'cid', avatarUrl: null, state: 'changes' }
  ])
  expect(githubReviewers(null)).toEqual([])
  expect(gitlabReviewers({ reviewers: [{ username: 'dee', avatar_url: 'd.png' }, { username: 'eve' }] }, { approved_by: [{ user: { username: 'eve' } }] })).toEqual([
    { login: 'dee', avatarUrl: 'd.png', state: 'requested' },
    { login: 'eve', avatarUrl: null, state: 'approved' }
  ])
})

test('githubMyReview reads the viewer verdict', () => {
  const detail = (state: string | null): unknown => ({ data: { repository: { pullRequest: { viewerLatestReview: state ? { state } : null } } } })
  expect(githubMyReview(detail('APPROVED'))).toBe('approved')
  expect(githubMyReview(detail('CHANGES_REQUESTED'))).toBe('changes')
  expect(githubMyReview(detail('COMMENTED'))).toBeNull()
  expect(githubMyReview(detail(null))).toBeNull()
  expect(githubMyReview(null)).toBeNull()
})

test('parseMergeTreeConflicts lists each conflicted path once and stops at the messages', () => {
  expect(parseMergeTreeConflicts('438ac9c\nsrc/a.ts\nsrc/a.ts\nb.md\n\nAuto-merging src/a.ts\n')).toEqual(['src/a.ts', 'b.md'])
  expect(parseMergeTreeConflicts('438ac9c\nx\n')).toEqual(['x'])
  expect(parseMergeTreeConflicts('438ac9c\n')).toEqual([])
})
