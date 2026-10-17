import type { McpTool } from '@treeix/sdk/main'
import { text } from '@treeix/shared/json'
import type { PullRequest, ReviewThread } from '../shared/types'
import { cli, failedJobLogs, pullRequestAt, pullRequestDetail } from './prs'

export type OpenComment = { id: string; threadId: string; author: string; body: string; path: string | null; line: number | null }

/** Every comment of the threads still open, one per line of work, so a watcher can tell new ones by id */
export const openComments = (threads: ReviewThread[]): OpenComment[] =>
  threads
    .filter((thread) => thread.resolved !== true)
    .flatMap((thread) =>
      thread.comments
        .filter((comment) => comment.body.trim())
        .map((comment) => ({ id: comment.id, threadId: thread.id, author: comment.author, body: comment.body, path: thread.path, line: thread.line }))
    )

const pullRequestArgs = {
  type: 'object',
  properties: { url: { type: 'string' }, repoPath: { type: 'string', description: 'A local clone of the repository the pull request is in' } },
  required: ['url', 'repoPath']
}

async function pullRequest(args: Record<string, unknown>): Promise<PullRequest> {
  const url = text(args.url).trim()
  const found = await pullRequestAt(url, [text(args.repoPath)])
  if (!found) throw new Error(`Not a pull request of ${text(args.repoPath)}: ${url}`)
  return found
}

/** Pull requests through the user's gh or glab login, for agents and the hub's pull request watcher */
export const pullRequestTools: McpTool[] = [
  {
    name: 'pr_status',
    description: 'A pull request as JSON: state (open, merged, closed), draft, branches, conflicts and the CI pipeline (passed, failed, running).',
    inputSchema: pullRequestArgs,
    run: (args) =>
      cli(async () => {
        const { number, title, state, draft, sourceBranch, targetBranch, conflicts, pipeline, url } = await pullRequest(args)
        return JSON.stringify({ number, title, state, draft, sourceBranch, targetBranch, conflicts, pipeline, url })
      })
  },
  {
    name: 'pr_failed_logs',
    description: 'The failed CI jobs of a pull request as JSON, each with the tail of its log.',
    inputSchema: pullRequestArgs,
    run: (args) => cli(async () => JSON.stringify(await failedJobLogs(await pullRequest(args))))
  },
  {
    name: 'pr_comments',
    description: 'The comments of every unresolved thread and of the conversation on a pull request as JSON: id, threadId, author, body, and path and line for a code comment.',
    inputSchema: pullRequestArgs,
    run: (args) => cli(async () => JSON.stringify(openComments((await pullRequestDetail(await pullRequest(args))).threads)))
  }
]
