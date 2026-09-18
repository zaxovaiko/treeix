import type { MainPlugin } from '@treeix/sdk/main'
import type { PullRequest, PullRequestComment, Reaction, ReviewThread } from '../shared/types'
import { commentOnPullRequest, listPullRequests, pullRequestDetail, pullRequestFile, pullRequestImage, reactToPullRequestComment, requestReview, setFileViewed, setThreadResolved } from './prs'

const plugin: MainPlugin = {
  tools: [
    { name: 'gh', purpose: 'GitHub pull requests', auth: true, releases: { url: 'https://api.github.com/repos/cli/cli/releases/latest', field: 'tag_name' } },
    { name: 'glab', purpose: 'GitLab merge requests', auth: true, releases: { url: 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest', field: 'tag_name' } }
  ],
  activate: (context) => {
    context.handle('list', (_, repoPaths: string[]) => listPullRequests(repoPaths))
    context.handle('detail', (_, pullRequest: PullRequest) => pullRequestDetail(pullRequest))
    context.handle('file', (_, pullRequest: PullRequest, filePath: string) => pullRequestFile(pullRequest, filePath))
    context.handle('image', (_, pullRequest: PullRequest, source: string) => pullRequestImage(pullRequest, source))
    context.handle('setThreadResolved', (_, pullRequest: PullRequest, thread: ReviewThread, resolved: boolean) => setThreadResolved(pullRequest, thread, resolved))
    context.handle('setFileViewed', (_, pullRequest: PullRequest, filePath: string, viewed: boolean) => setFileViewed(pullRequest, filePath, viewed))
    context.handle('requestReview', (_, pullRequest: PullRequest, login: string) => requestReview(pullRequest, login))
    context.handle('comment', (_, pullRequest: PullRequest, comment: PullRequestComment) => commentOnPullRequest(pullRequest, comment))
    context.handle('react', (_, pullRequest: PullRequest, commentId: string, reaction: Reaction) => reactToPullRequestComment(pullRequest, commentId, reaction))
  }
}

export default plugin
