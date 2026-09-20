import { createBridge, definePluginSettings } from '@treeix/sdk'
import type { FilePatch } from '@treeix/shared/types'
import type { ConflictResult, ImageResult, PullRequest, PullRequestComment, PullRequestDetail, PullRequestList, Reaction, ReviewThread, ReviewVerdict, MergeMethod } from '../shared/types'

const bridge = createBridge('pull-requests')

export const api = {
  listPullRequests: (repoPaths: string[]) => bridge.invoke<PullRequestList>('list', repoPaths),
  pullRequestDetail: (pullRequest: PullRequest) => bridge.invoke<PullRequestDetail>('detail', pullRequest),
  pullRequestFile: (pullRequest: PullRequest, filePath: string) => bridge.invoke<string>('file', pullRequest, filePath),
  setThreadResolved: (pullRequest: PullRequest, thread: ReviewThread, resolved: boolean) => bridge.invoke<void>('setThreadResolved', pullRequest, thread, resolved),
  setFileViewed: (pullRequest: PullRequest, filePath: string, viewed: boolean) => bridge.invoke<void>('setFileViewed', pullRequest, filePath, viewed),
  editComment: (pullRequest: PullRequest, commentId: string, body: string) => bridge.invoke<void>('editComment', pullRequest, commentId, body),
  deleteComment: (pullRequest: PullRequest, commentId: string) => bridge.invoke<void>('deleteComment', pullRequest, commentId),
  merge: (pullRequest: PullRequest, method: MergeMethod, deleteBranch: boolean) => bridge.invoke<void>('merge', pullRequest, method, deleteBranch),
  submitReview: (pullRequest: PullRequest, verdict: ReviewVerdict, body: string) => bridge.invoke<void>('submitReview', pullRequest, verdict, body),
  setDraft: (pullRequest: PullRequest, draft: boolean) => bridge.invoke<void>('setDraft', pullRequest, draft),
  requestReview: (pullRequest: PullRequest, login: string) => bridge.invoke<void>('requestReview', pullRequest, login),
  commentOnPullRequest: (pullRequest: PullRequest, comment: PullRequestComment) => bridge.invoke<void>('comment', pullRequest, comment),
  reactToPullRequestComment: (pullRequest: PullRequest, commentId: string, reaction: Reaction) => bridge.invoke<void>('react', pullRequest, commentId, reaction),
  conflictingFiles: (pullRequest: PullRequest) => bridge.invoke<ConflictResult>('conflicts', pullRequest),
  image: (pullRequest: PullRequest, source: string) => bridge.invoke<ImageResult>('image', pullRequest, source)
}

// Attachments on a private GitLab project need the CLI's session; a browser request just gets a login page
const PRIVATE_UPLOAD = /\/uploads\/[0-9a-f]{32}\//
const MAX_CACHED_IMAGES = 100
const images = new Map<string, Promise<string>>()

/** Loads a description's images through the CLI when the browser can't see them */
export const imageResolver =
  (pullRequest: PullRequest) =>
  (source: string): Promise<string> | null => {
    if (pullRequest.provider !== 'gitlab' || !PRIVATE_UPLOAD.test(source)) return null
    const pending =
      images.get(source) ??
      api.image(pullRequest, source).then((result) => {
        if ('error' in result) throw new Error(result.error)
        return result.dataUrl
      })
    // Re-inserted on every use, so the least recently shown image goes first
    images.delete(source)
    images.set(source, pending)
    if (images.size > MAX_CACHED_IMAGES) images.delete(images.keys().next().value ?? '')
    pending.catch(() => images.delete(source))
    return pending
  }

export type { FilePatch }

export const POLL_MINUTES = [0, 1, 5, 15] as const
export type PollMinutes = (typeof POLL_MINUTES)[number]

export const prSettings = definePluginSettings('pull-requests', (stored) => ({
  /** Pull request files one at a time, or every file in one scroll like GitHub */
  prFilesView: stored.prFilesView === 'single' ? ('single' as const) : ('all' as const),
  /** Minutes between background refreshes; 0 turns polling off */
  prPollMinutes: POLL_MINUTES.find((minutes) => minutes === stored.prPollMinutes) ?? (5 as PollMinutes)
}))
