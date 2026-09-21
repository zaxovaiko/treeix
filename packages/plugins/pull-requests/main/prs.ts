import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { FilePatch } from '@treeix/shared/types'
import type { ConflictResult, ImageResult, Provider, PullRequest, PullRequestDetail, PullRequestList, PullRequestComment, PullRequestState, Reaction, Reviewer, ReviewStatus, ReviewThread, ReviewVerdict, ThreadComment, MergeMethod } from '../shared/types'
import { REACTIONS } from '../shared/types'
import { splitPatch } from '@treeix/host/git'

const exec = promisify(execFile)
const LIST_LIMIT = 50
const CLI_TIMEOUT_MS = 60_000

type Json = Record<string, unknown>

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const object = (value: unknown): Json => (isJson(value) ? value : {})
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isJson) : [])

function failureMessage(reason: unknown): string {
  const stderr = isJson(reason) ? text(reason.stderr).trim() : ''
  return (stderr || String(reason)).split('\n')[0]
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec(command, args, { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** Writes send a JSON body on stdin, so text never passes through CLI flag parsing */
async function runWithBody(command: string, args: string[], cwd: string, body: Json): Promise<string> {
  // gh labels --input as JSON itself; glab sends it untyped and GitLab answers 415 Unsupported Media Type
  const pending = exec(command, [...args, '-H', 'Content-Type: application/json', '--input', '-'], { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  pending.child.stdin?.end(JSON.stringify(body))
  return (await pending).stdout
}

const runJson = async (command: string, args: string[], cwd: string): Promise<unknown> =>
  JSON.parse(await run(command, args, cwd))

export type Remote = { provider: Provider; host: string; slug: string }

export function parseRemote(url: string): Remote | null {
  const match = url.trim().match(/^(?:[\w+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/)
  if (!match) return null
  const [, host, slug] = match
  if (host === 'github.com') return { provider: 'github', host, slug }
  if (host.includes('gitlab')) return { provider: 'gitlab', host, slug }
  return null
}

async function remoteOf(repoPath: string): Promise<Remote | null> {
  const url = await run('git', ['remote', 'get-url', 'origin'], repoPath).catch(() => '')
  return parseRemote(url)
}

const GITLAB_STATES: Record<string, PullRequestState> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'closed' }

/** `gh pr list` has no avatar field; bots come through as `app/<name>` and have no profile image */
export const githubAvatar = (login: string): string | null =>
  login && !login.includes('/') ? `https://github.com/${login}.png?size=64` : null

export function toGithubPullRequest(raw: Json, repoPath: string): PullRequest {
  return {
    provider: 'github',
    repoPath,
    number: numberOrNull(raw.number) ?? 0,
    title: text(raw.title),
    author: text(object(raw.author).login),
    authorAvatarUrl: githubAvatar(text(object(raw.author).login)),
    sourceBranch: text(raw.headRefName),
    targetBranch: text(raw.baseRefName),
    state: text(raw.state) === 'MERGED' ? 'merged' : text(raw.state) === 'CLOSED' ? 'closed' : 'open',
    draft: raw.isDraft === true,
    updatedAt: text(raw.updatedAt),
    url: text(raw.url),
    additions: numberOrNull(raw.additions),
    deletions: numberOrNull(raw.deletions),
    changedFiles: numberOrNull(raw.changedFiles),
    commentCount: null,
    review: null,
    conflicts: text(raw.mergeable) === 'CONFLICTING'
  }
}

export function toGitlabPullRequest(raw: Json, repoPath: string): PullRequest {
  return {
    provider: 'gitlab',
    repoPath,
    number: numberOrNull(raw.iid) ?? 0,
    title: text(raw.title),
    author: text(object(raw.author).username),
    authorAvatarUrl: text(object(raw.author).avatar_url) || null,
    sourceBranch: text(raw.source_branch),
    targetBranch: text(raw.target_branch),
    state: GITLAB_STATES[text(raw.state)] ?? 'open',
    draft: raw.draft === true,
    updatedAt: text(raw.updated_at),
    url: text(raw.web_url),
    additions: null,
    deletions: null,
    changedFiles: null,
    commentCount: numberOrNull(raw.user_notes_count),
    review: null,
    conflicts: raw.has_conflicts === true && text(raw.state) === 'opened'
  }
}

// `gh pr list --json latestReviews,commits` exceeds GitHub's GraphQL node limit, so review state has its own narrow query
const REVIEW_QUERY = `query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${LIST_LIMIT}) {
    nodes {
      ... on PullRequest {
        number
        author { login }
        reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } } } }
        latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
        commits(last: 100) { nodes { commit { oid } } }
        comments { totalCount }
        reviewThreads { totalCount }
      }
    }
  }
}`

const REVIEW_STATES: Record<string, ReviewStatus['state']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }

/** Conversation comments plus review threads per PR number, from REVIEW_QUERY's response */
export function githubCommentCounts(raw: unknown): Map<number, number> {
  const counts = new Map<number, number>()
  for (const pr of list(object(object(object(raw).data).search).nodes)) {
    const number = numberOrNull(pr.number)
    if (number === null) continue
    counts.set(number, (numberOrNull(object(pr.comments).totalCount) ?? 0) + (numberOrNull(object(pr.reviewThreads).totalCount) ?? 0))
  }
  return counts
}

/** Review status of each open PR by number, from REVIEW_QUERY's response */
export function githubReviewStatuses(raw: unknown): Map<number, ReviewStatus> {
  const data = object(object(raw).data)
  const viewer = text(object(data.viewer).login)
  const statuses = new Map<number, ReviewStatus>()
  for (const pr of list(object(data.search).nodes)) {
    const number = numberOrNull(pr.number)
    if (number === null) continue
    const oids = list(object(pr.commits).nodes).map((node) => text(object(node.commit).oid))
    const mine = list(object(pr.latestReviews).nodes).find((review) => text(object(review.author).login) === viewer)
    const reviewedOid = mine ? text(object(mine.commit).oid) : ''
    // A review on a commit outside the last 100 counts every listed commit as new
    const newCommits = reviewedOid ? oids.length - 1 - oids.lastIndexOf(reviewedOid) : 0
    const requested = list(object(pr.reviewRequests).nodes).some((node) => text(object(node.requestedReviewer).login) === viewer)
    const state: ReviewStatus['state'] =
      text(object(pr.author).login) === viewer ? 'yours' : requested ? 'requested' : mine ? (REVIEW_STATES[text(mine.state)] ?? 'commented') : 'unreviewed'
    const changesRequested = list(object(pr.latestReviews).nodes).some(
      (review) => text(review.state) === 'CHANGES_REQUESTED' && text(object(review.author).login) !== viewer
    )
    statuses.set(number, { state, newCommits: state === 'yours' ? 0 : newCommits, ...(changesRequested && { changesRequested }) })
  }
  return statuses
}

// Same order and size as `gh pr list`, so counts cover every listed PR; review marks only apply to open ones
const githubReviewData = (remote: Remote, repoPath: string): Promise<unknown> =>
  runJson('gh', ['api', 'graphql', '--hostname', remote.host, '-f', `q=repo:${remote.slug} is:pr sort:updated-desc`, '-f', `query=${REVIEW_QUERY}`], repoPath)

async function listForRepo(repoPath: string): Promise<PullRequest[]> {
  const remote = await remoteOf(repoPath)
  if (!remote) return []
  if (remote.provider === 'github') {
    const fields = 'number,title,author,headRefName,baseRefName,state,isDraft,updatedAt,additions,deletions,changedFiles,url,mergeable'
    const args = ['pr', 'list', '-R', `${remote.host}/${remote.slug}`, '--state', 'all', '--limit', `${LIST_LIMIT}`, '--json', fields]
    // Review marks are a nicety: the list still loads when that query fails
    const [pullRequests, reviewData] = await Promise.all([
      runJson('gh', args, repoPath).then((raw) => list(raw).map((pr) => toGithubPullRequest(pr, repoPath))),
      githubReviewData(remote, repoPath).catch(() => null)
    ])
    const reviews = githubReviewStatuses(reviewData)
    const counts = githubCommentCounts(reviewData)
    return pullRequests.map((pr) => ({
      ...pr,
      review: pr.state === 'open' ? (reviews.get(pr.number) ?? null) : null,
      commentCount: counts.get(pr.number) ?? null
    }))
  }
  const path = `projects/:id/merge_requests?state=all&order_by=updated_at&per_page=${LIST_LIMIT}`
  return list(await runJson('glab', ['api', path], repoPath)).map((raw) => toGitlabPullRequest(raw, repoPath))
}

export async function listPullRequests(repoPaths: string[]): Promise<PullRequestList> {
  const results = await Promise.allSettled(repoPaths.map(listForRepo))
  const errors = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${basename(repoPaths[index])}: ${failureMessage(result.reason)}`] : []
  )
  const pullRequests = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { pullRequests, errors }
}

function reactionCounts(raw: unknown): Record<Reaction, number> {
  const counts = object(raw)
  const result = { '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 }
  for (const reaction of REACTIONS) result[reaction] = numberOrNull(counts[reaction]) ?? 0
  return result
}

/** GitHub users carry `login`, GitLab users `username`; both expose `avatar_url` */
const toComment = (id: string, user: unknown, body: unknown, createdAt: unknown, reactions: unknown = {}): ThreadComment => ({
  id,
  author: text(object(user).login) || text(object(user).username),
  avatarUrl: text(object(user).avatar_url) || null,
  body: text(body),
  createdAt: text(createdAt),
  reactions: reactionCounts(reactions)
})

type ThreadState = { resolveId: string; resolved: boolean }

/** Resolved state of review threads keyed by their root comment id; REST review comments don't carry it */
const REVIEWER_STATES: Record<string, Reviewer['state']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }

/** Pending requests first, then everyone who reviewed; the author never counts as a reviewer */
export function githubReviewers(raw: unknown): Reviewer[] {
  const pr = object(object(object(object(raw).data).repository).pullRequest)
  const author = text(object(pr.author).login)
  const reviewers = new Map<string, Reviewer>()
  for (const review of list(object(pr.latestReviews).nodes)) {
    const login = text(object(review.author).login)
    const state = REVIEWER_STATES[text(review.state)]
    if (login && login !== author && state) reviewers.set(login, { login, avatarUrl: text(object(review.author).avatarUrl) || null, state })
  }
  for (const request of list(object(pr.reviewRequests).nodes)) {
    const reviewer = object(request.requestedReviewer)
    const login = text(reviewer.login)
    if (login) reviewers.set(login, { login, avatarUrl: text(reviewer.avatarUrl) || null, state: 'requested' })
  }
  return [...reviewers.values()].sort((a, b) => Number(b.state === 'requested') - Number(a.state === 'requested'))
}

export function githubMyReview(raw: unknown): PullRequestDetail['myReview'] {
  const state = text(object(object(object(object(object(raw).data).repository).pullRequest).viewerLatestReview).state)
  return state === 'APPROVED' ? 'approved' : state === 'CHANGES_REQUESTED' ? 'changes' : null
}

/** Files the viewer marked as viewed, from the same pull request query */
export const githubViewedFiles = (raw: unknown): string[] =>
  list(object(object(object(object(object(raw).data).repository).pullRequest).files).nodes)
    .filter((file) => file.viewerViewedState === 'VIEWED')
    .map((file) => text(file.path))

export function githubThreadStates(raw: unknown): Map<number, ThreadState> {
  const threads = object(object(object(object(object(raw).data).repository).pullRequest).reviewThreads).nodes
  const states = new Map<number, ThreadState>()
  for (const thread of list(threads)) {
    const rootId = numberOrNull(object(list(object(thread.comments).nodes)[0]).databaseId)
    if (rootId !== null) states.set(rootId, { resolveId: text(thread.id), resolved: thread.isResolved === true })
  }
  return states
}

export function githubThreads(reviewComments: Json[], issueComments: Json[], states = new Map<number, ThreadState>()): ReviewThread[] {
  const threads = new Map<number, ReviewThread>()
  for (const raw of reviewComments) {
    const rootId = numberOrNull(raw.in_reply_to_id) ?? numberOrNull(raw.id) ?? 0
    const comment = toComment(`review:${raw.id}`, raw.user, raw.body, raw.created_at, raw.reactions)
    const existing = threads.get(rootId)
    if (existing) {
      existing.comments.push(comment)
      continue
    }
    threads.set(rootId, {
      id: `${rootId}`,
      path: text(raw.path) || null,
      line: numberOrNull(raw.line) ?? numberOrNull(raw.original_line),
      side: text(raw.side) === 'LEFT' ? 'deletions' : 'additions',
      comments: [comment],
      resolved: states.get(rootId)?.resolved ?? null,
      resolveId: states.get(rootId)?.resolveId ?? null
    })
  }
  const conversation: ReviewThread[] = issueComments.length
    ? [
        {
          id: 'conversation',
          path: null,
          line: null,
          side: 'additions',
          comments: issueComments.map((raw) =>
            toComment(`issue:${raw.id}`, raw.user, raw.body, raw.created_at, raw.reactions)
          ),
          resolved: null,
          resolveId: null
        }
      ]
    : []
  return [...conversation, ...threads.values()]
}

export function gitlabThreads(discussions: Json[]): ReviewThread[] {
  return discussions.flatMap((discussion) => {
    const notes = list(discussion.notes).filter((note) => note.system !== true)
    if (notes.length === 0) return []
    const position = object(notes[0].position)
    const newLine = numberOrNull(position.new_line)
    return [
      {
        id: text(discussion.id),
        path: text(position.new_path) || text(position.old_path) || null,
        line: newLine ?? numberOrNull(position.old_line),
        side: newLine === null && position.old_line !== undefined ? ('deletions' as const) : ('additions' as const),
        // ponytail: GitLab notes carry no award counts, fetching them costs one call per note
        comments: notes.map((note) => toComment(`note:${note.id}`, note.author, note.body, note.created_at)),
        resolved: notes[0].resolvable === true ? notes.every((note) => note.resolvable !== true || note.resolved === true) : null,
        resolveId: notes[0].resolvable === true ? text(discussion.id) : null
      }
    ]
  })
}

const stripPrefix = (path: string, prefix: string): string => (path.startsWith(prefix) ? path.slice(prefix.length) : path)

/** `glab mr diff` prints file headers without `diff --git` lines, which the diff splitter needs */
export function normalizeGitlabDiff(diff: string): string {
  const lines = diff.split('\n')
  const output: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const next = lines[index + 1] ?? ''
    const previous = output.at(-1) ?? ''
    const isHeader = line.startsWith('--- ') && next.startsWith('+++ ') && !previous.startsWith('index ')
    if (!isHeader || previous.startsWith('diff --git')) {
      output.push(line)
      continue
    }
    const from = stripPrefix(line.slice(4).trim(), 'a/')
    const to = stripPrefix(next.slice(4).trim(), 'b/')
    const path = to === '/dev/null' ? from : to
    output.push(
      `diff --git a/${path} b/${path}`,
      from === '/dev/null' ? '--- /dev/null' : `--- a/${from}`,
      to === '/dev/null' ? '+++ /dev/null' : `+++ b/${to}`
    )
    index++
  }
  return output.join('\n')
}

/** Rebuilds git-style patches from the pull request files API; files GitHub omits a patch for keep only their header */
export function githubFilesToPatches(files: Json[]): FilePatch[] {
  return files.map((file) => {
    const path = text(file.filename)
    const previous = text(file.previous_filename) || path
    const status = text(file.status)
    const from = status === 'added' ? '/dev/null' : `a/${previous}`
    const to = status === 'removed' ? '/dev/null' : `b/${path}`
    const hunks = text(file.patch)
    return {
      path,
      patch: [`diff --git a/${previous} b/${path}`, `--- ${from}`, `+++ ${to}`, ...(hunks ? [hunks] : [])].join('\n') + '\n',
      additions: numberOrNull(file.additions) ?? 0,
      deletions: numberOrNull(file.deletions) ?? 0
    }
  })
}

export async function pullRequestDetail(pullRequest: PullRequest): Promise<PullRequestDetail> {
  const { repoPath, number } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')

  if (remote.provider === 'github') {
    const repo = `${remote.host}/${remote.slug}`
    const pages = (path: string): Promise<Json[]> =>
      runJson('gh', ['api', '--hostname', remote.host, '--paginate', '--slurp', path], repoPath).then((result) =>
        Array.isArray(result) ? result.flatMap(list) : []
      )
    // The diff endpoint refuses PRs over 300 files; the files API goes to 3000 with per-file patches
    const patches = run('gh', ['pr', 'diff', `${number}`, '-R', repo, '--color=never'], repoPath).then(splitPatch, () =>
      pages(`repos/${remote.slug}/pulls/${number}/files`).then(githubFilesToPatches)
    )
    const [owner, name] = remote.slug.split('/')
    const threadQuery = `query($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } }
        files(first: 100) { nodes { path viewerViewedState } }
        author { login }
        reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login avatarUrl } } } }
        latestReviews(first: 30) { nodes { author { login avatarUrl } state } }
        viewerLatestReview { state }
      } }
    }`
    const [filePatches, view, reviewComments, issueComments, extra] = await Promise.all([
      patches,
      runJson('gh', ['pr', 'view', `${number}`, '-R', repo, '--json', 'body'], repoPath),
      pages(`repos/${remote.slug}/pulls/${number}/comments`),
      pages(`repos/${remote.slug}/issues/${number}/comments`),
      // Without it threads and files still show, just without resolve buttons and viewed marks
      runJson('gh', ['api', 'graphql', '--hostname', remote.host, '-f', `query=${threadQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], repoPath).catch(() => null)
    ])
    return {
      body: text(object(view).body),
      patches: filePatches,
      threads: githubThreads(reviewComments, issueComments, githubThreadStates(extra)),
      // ponytail: first 100 files only, paginate when PRs get bigger
      viewedFiles: extra === null ? null : githubViewedFiles(extra),
      reviewers: githubReviewers(extra),
      myReview: githubMyReview(extra),
      viewer: text(object(object(object(extra).data).viewer).login) || null
    }
  }

  const [diff, request, discussions, approvals, viewer] = await Promise.all([
    run('glab', ['mr', 'diff', `${number}`, '--color=never'], repoPath),
    runJson('glab', ['api', `projects/:id/merge_requests/${number}`], repoPath),
    // ponytail: first 100 discussions only, paginate if MRs get that busy
    runJson('glab', ['api', `projects/:id/merge_requests/${number}/discussions?per_page=100`], repoPath),
    runJson('glab', ['api', `projects/:id/merge_requests/${number}/approvals`], repoPath).catch(() => null),
    gitlabUser(repoPath)
  ])
  return {
    body: text(object(request).description),
    patches: splitPatch(normalizeGitlabDiff(diff)),
    threads: gitlabThreads(list(discussions)),
    viewedFiles: null,
    reviewers: gitlabReviewers(request, approvals),
    // GitLab tells only whether you approved; a change request shows as your reviewer state, not here
    myReview: object(approvals).user_has_approved === true ? 'approved' : null,
    viewer
  }
}

/** GitLab lists assigned reviewers and, separately, who approved */
export function gitlabReviewers(request: unknown, approvals: unknown): Reviewer[] {
  const approved = new Set(list(object(approvals).approved_by).map((entry) => text(object(entry.user).username)))
  return list(object(request).reviewers).map((user) => ({
    login: text(user.username),
    avatarUrl: text(user.avatar_url) || null,
    state: approved.has(text(user.username)) ? ('approved' as const) : ('requested' as const)
  }))
}

export async function commentOnPullRequest(pullRequest: PullRequest, comment: PullRequestComment): Promise<void> {
  const { repoPath, number } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  const { body, threadId, path, line, side } = comment

  if (remote.provider === 'github') {
    const api = (endpoint: string, payload: Json): Promise<string> =>
      runWithBody('gh', ['api', '--hostname', remote.host, '-X', 'POST', `repos/${remote.slug}/${endpoint}`], repoPath, payload)
    if (threadId && threadId !== 'conversation') {
      await api(`pulls/${number}/comments/${threadId}/replies`, { body })
    } else if (path && line) {
      const view = await runJson('gh', ['pr', 'view', `${number}`, '-R', `${remote.host}/${remote.slug}`, '--json', 'headRefOid'], repoPath)
      const commit = text(object(view).headRefOid)
      await api(`pulls/${number}/comments`, { body, commit_id: commit, path, line, side: side === 'deletions' ? 'LEFT' : 'RIGHT' })
    } else if (path) {
      // A comment on the whole file rather than a line
      const view = await runJson('gh', ['pr', 'view', `${number}`, '-R', `${remote.host}/${remote.slug}`, '--json', 'headRefOid'], repoPath)
      await api(`pulls/${number}/comments`, { body, commit_id: text(object(view).headRefOid), path, subject_type: 'file' })
    } else {
      await api(`issues/${number}/comments`, { body })
    }
    return
  }

  const api = (endpoint: string, payload: Json): Promise<string> =>
    runWithBody('glab', ['api', '-X', 'POST', `projects/:id/merge_requests/${number}/${endpoint}`], repoPath, payload)
  if (threadId) {
    await api(`discussions/${threadId}/notes`, { body })
  } else if (path && line) {
    const refs = object(object(await runJson('glab', ['api', `projects/:id/merge_requests/${number}`], repoPath)).diff_refs)
    // ponytail: unchanged context lines need both old_line and new_line, which the diff view does not track
    const position = side === 'deletions' ? { old_path: path, old_line: line } : { new_path: path, new_line: line }
    await api('discussions', {
      body,
      position: { position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, ...position }
    })
  } else if (path) {
    // File-level discussions need GitLab 16.x or newer
    const refs = object(object(await runJson('glab', ['api', `projects/:id/merge_requests/${number}`], repoPath)).diff_refs)
    await api('discussions', {
      body,
      position: { position_type: 'file', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, new_path: path, old_path: path }
    })
  } else {
    await api('notes', { body })
  }
}

const GITLAB_AWARDS: Record<Reaction, string> = {
  '+1': 'thumbsup',
  '-1': 'thumbsdown',
  laugh: 'laughing',
  hooray: 'tada',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
  eyes: 'eyes'
}

/** Comment ids are `review:<id>` or `issue:<id>` on GitHub and `note:<id>` on GitLab */
export async function reactToPullRequestComment(pullRequest: PullRequest, commentId: string, reaction: Reaction): Promise<void> {
  const { repoPath, number } = pullRequest
  const [kind, id] = commentId.split(':')
  if (!/^\d+$/.test(id ?? '') || !REACTIONS.includes(reaction)) throw new Error('Invalid reaction target')
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  if (remote.provider === 'github') {
    const endpoint = kind === 'review' ? `pulls/comments/${id}/reactions` : `issues/comments/${id}/reactions`
    await runWithBody('gh', ['api', '--hostname', remote.host, '-X', 'POST', `repos/${remote.slug}/${endpoint}`], repoPath, {
      content: reaction
    })
    return
  }
  await runWithBody('glab', ['api', '-X', 'POST', `projects/:id/merge_requests/${number}/notes/${id}/award_emoji`], repoPath, {
    name: GITLAB_AWARDS[reaction]
  })
}

/** Who glab is signed in as, per repository folder; asked once per run */
const gitlabUsers = new Map<string, Promise<string | null>>()
function gitlabUser(repoPath: string): Promise<string | null> {
  const known = gitlabUsers.get(repoPath)
  if (known) return known
  const asking = runJson('glab', ['api', 'user'], repoPath).then((user) => text(object(user).username) || null, () => null)
  gitlabUsers.set(repoPath, asking)
  return asking
}

/** The API path of one of your comments, from its `review:`, `issue:` or `note:` id */
async function commentEndpoint(pullRequest: PullRequest, commentId: string): Promise<{ command: 'gh' | 'glab'; args: string[] }> {
  const [kind, id] = commentId.split(':')
  if (!/^\d+$/.test(id ?? '')) throw new Error('Invalid comment')
  const remote = await remoteOf(pullRequest.repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  if (remote.provider === 'github') {
    return { command: 'gh', args: ['api', '--hostname', remote.host, `repos/${remote.slug}/${kind === 'review' ? 'pulls' : 'issues'}/comments/${id}`] }
  }
  return { command: 'glab', args: ['api', `projects/:id/merge_requests/${pullRequest.number}/notes/${id}`] }
}

export async function editPullRequestComment(pullRequest: PullRequest, commentId: string, body: string): Promise<void> {
  const { command, args } = await commentEndpoint(pullRequest, commentId)
  const [api, ...rest] = args
  await runWithBody(command, [api, '-X', command === 'gh' ? 'PATCH' : 'PUT', ...rest], pullRequest.repoPath, { body }).catch((reason: unknown) => {
    throw new Error(failureMessage(reason))
  })
}

export async function deletePullRequestComment(pullRequest: PullRequest, commentId: string): Promise<void> {
  const { command, args } = await commentEndpoint(pullRequest, commentId)
  const [api, ...rest] = args
  await run(command, [api, '-X', 'DELETE', ...rest], pullRequest.repoPath).catch((reason: unknown) => {
    throw new Error(failureMessage(reason))
  })
}

/** A file as it is on the pull request's source branch, e.g. to preview its markdown */
export async function pullRequestFile(pullRequest: PullRequest, filePath: string): Promise<string> {
  const { repoPath, sourceBranch } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('No origin remote')
  const ref = encodeURIComponent(sourceBranch)
  if (remote.provider === 'github') {
    const path = filePath.split('/').map(encodeURIComponent).join('/')
    return run('gh', ['api', '--hostname', remote.host, '-H', 'Accept: application/vnd.github.raw', `repos/${remote.slug}/contents/${path}?ref=${ref}`], repoPath)
  }
  return run('glab', ['api', `projects/:id/repository/files/${encodeURIComponent(filePath)}/raw?ref=${ref}`], repoPath)
}

export async function setThreadResolved(pullRequest: PullRequest, thread: ReviewThread, resolved: boolean): Promise<void> {
  const { repoPath, number } = pullRequest
  if (!thread.resolveId) throw new Error('This thread cannot be resolved')
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  if (remote.provider === 'github') {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
    const query = `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`
    await run('gh', ['api', 'graphql', '--hostname', remote.host, '-f', `query=${query}`, '-f', `id=${thread.resolveId}`], repoPath)
    return
  }
  await run('glab', ['api', '-X', 'PUT', `projects/:id/merge_requests/${number}/discussions/${thread.resolveId}?resolved=${resolved}`], repoPath)
}

/** GitHub's "Viewed" checkbox; GitLab has no API for it, so the renderer keeps those locally */
export async function setFileViewed(pullRequest: PullRequest, filePath: string, viewed: boolean): Promise<void> {
  const { repoPath, number } = pullRequest
  const remote = await remoteOf(repoPath)
  if (remote?.provider !== 'github') throw new Error('Only GitHub stores viewed files')
  const [owner, name] = remote.slug.split('/')
  const idQuery = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }'
  const ids = await runJson('gh', ['api', 'graphql', '--hostname', remote.host, '-f', `query=${idQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], repoPath)
  const pullRequestId = text(object(object(object(object(ids).data).repository).pullRequest).id)
  const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const query = `mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
  await run('gh', ['api', 'graphql', '--hostname', remote.host, '-f', `query=${query}`, '-f', `id=${pullRequestId}`, '-f', `path=${filePath}`], repoPath)
}

/** Asks a reviewer to look again, e.g. after pushing fixes for their comments */
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
/** Files attached to a description or comment, which only a signed-in user may read */
const GITLAB_UPLOAD = /\/uploads\/([0-9a-f]{32})\/([^/?#]+)/

export async function pullRequestImage(pullRequest: PullRequest, source: string): Promise<ImageResult> {
  const upload = source.match(GITLAB_UPLOAD)
  if (!upload || pullRequest.provider !== 'gitlab') return { error: 'Not an upload this app can fetch' }
  const [, secret, name] = upload
  try {
    // glab signs the request; the browser has no session on the GitLab host
    const { stdout } = await exec('glab', ['api', `projects/:id/uploads/${secret}/${name}`], {
      cwd: pullRequest.repoPath,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer'
    })
    const type = MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'
    return { dataUrl: `data:${type};base64,${stdout.toString('base64')}` }
  } catch (reason) {
    return { error: failureMessage(reason) }
  }
}

/**
 * Merges now, never as auto-merge. GitHub goes through the API because `gh pr merge --delete-branch` also deletes
 * and switches branches in the local checkout; GitLab's CLI leaves the checkout alone.
 */
export async function mergePullRequest(pullRequest: PullRequest, method: MergeMethod, deleteBranch: boolean): Promise<void> {
  const { repoPath, number, sourceBranch } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  try {
    if (remote.provider === 'github') {
      await run('gh', ['api', '--hostname', remote.host, '-X', 'PUT', `repos/${remote.slug}/pulls/${number}/merge`, '-f', `merge_method=${method}`], repoPath)
      if (deleteBranch) await run('gh', ['api', '--hostname', remote.host, '-X', 'DELETE', `repos/${remote.slug}/git/refs/heads/${sourceBranch.split('/').map(encodeURIComponent).join('/')}`], repoPath)
      return
    }
    const how = method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : []
    await run('glab', ['mr', 'merge', String(number), '--yes', '--auto-merge=false', ...how, ...(deleteBranch ? ['--remove-source-branch'] : [])], repoPath)
  } catch (reason) {
    throw new Error(failureMessage(reason))
  }
}

/** Approves, or requests changes with `body` explaining why */
export async function submitReview(pullRequest: PullRequest, verdict: ReviewVerdict, body: string): Promise<void> {
  const { repoPath, number } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  try {
    if (remote.provider === 'github') {
      await run('gh', ['pr', 'review', String(number), verdict === 'approve' ? '--approve' : '--request-changes', ...(body ? ['--body', body] : [])], repoPath)
    } else if (verdict === 'approve') {
      await run('glab', ['mr', 'approve', String(number)], repoPath)
    } else {
      // No REST endpoint sets the reviewer state; the quick action does, as the web UI's "Request changes" does
      await runWithBody('glab', ['api', '-X', 'POST', `projects/:id/merge_requests/${number}/notes`], repoPath, { body: `${body}\n\n/submit_review requested_changes` })
    }
  } catch (reason) {
    throw new Error(failureMessage(reason))
  }
}

/** Marks a draft ready for review, or turns it back into a draft */
export async function setDraft(pullRequest: PullRequest, draft: boolean): Promise<void> {
  const { repoPath, number } = pullRequest
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  try {
    if (remote.provider === 'github') await run('gh', ['pr', 'ready', String(number), '-R', `${remote.host}/${remote.slug}`, ...(draft ? ['--undo'] : [])], repoPath)
    else await run('glab', ['mr', 'update', String(number), draft ? '--draft' : '--ready'], repoPath)
  } catch (reason) {
    throw new Error(failureMessage(reason))
  }
}

export async function requestReview(pullRequest: PullRequest, login: string): Promise<void> {
  const { repoPath, number } = pullRequest
  if (!/^[\w.-]+$/.test(login)) throw new Error(`Invalid reviewer name: ${login}`)
  const remote = await remoteOf(repoPath)
  if (!remote) throw new Error('Repository has no GitHub or GitLab remote')
  if (remote.provider === 'github') {
    await runWithBody('gh', ['api', '--hostname', remote.host, '-X', 'POST', `repos/${remote.slug}/pulls/${number}/requested_reviewers`], repoPath, { reviewers: [login] })
    return
  }
  // GitLab has no re-request endpoint; the quick action in a note does it, as the web UI's button does
  await runWithBody('glab', ['api', '-X', 'POST', `projects/:id/merge_requests/${number}/notes`], repoPath, { body: `/request_review @${login}` })
}

/** `git merge-tree --name-only` output: the tree id, then each conflicted path (once per stage), then a blank line */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n')
  const end = rest.indexOf('')
  return [...new Set(end === -1 ? rest : rest.slice(0, end))]
}

/**
 * Merges the pull request into its target in memory, like the provider does. Read-only for the checkout: shas come
 * from ls-remote, fetch stores objects only (no refs, no FETCH_HEAD) and merge-tree never touches the worktree
 */
export async function conflictingFiles(pullRequest: PullRequest): Promise<ConflictResult> {
  const { repoPath, number, targetBranch, provider } = pullRequest
  // The provider's own ref works for forks, whose branch isn't on origin
  const headRef = provider === 'github' ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`
  const baseRef = `refs/heads/${targetBranch}`
  try {
    const shas = new Map(
      (await run('git', ['ls-remote', 'origin', baseRef, headRef], repoPath))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split('\t')
          return [ref, sha] as const
        })
    )
    const base = shas.get(baseRef)
    const head = shas.get(headRef)
    if (!base || !head) return { error: `Couldn't find ${base ? headRef : baseRef} on origin` }
    await run('git', ['fetch', '--quiet', '--no-write-fetch-head', '--no-tags', 'origin', baseRef, headRef], repoPath)
    await run('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], repoPath)
    return { files: [] }
  } catch (reason) {
    // Exit 1 is merge-tree reporting conflicts, with the paths on stdout
    if (isJson(reason) && reason.code === 1 && text(reason.stdout)) return { files: parseMergeTreeConflicts(text(reason.stdout)) }
    return { error: failureMessage(reason) }
  }
}
