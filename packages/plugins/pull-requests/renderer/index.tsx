import { lazy, Suspense, useEffect } from 'react'
import { type DocumentTab, type HostApi, type RendererPlugin, useHost } from '@treeix/sdk'
import { extractLines, type ReviewComment } from '@treeix/shared/comments'
import type { FilePatch } from '@treeix/shared/types'
import { Row, Segmented } from '@treeix/app/settingsUi'
import { baseName } from '@treeix/app/Sidebar'
import { useSettings } from '@treeix/app/settings'
import { errorMessage } from '@treeix/app/ui'
import type { PullRequest, ReviewThread } from '../shared/types'
import { POLL_MINUTES, prSettings } from './api'
import { lastFetched, refreshPullRequests, scopeKeyOf } from './pullRequestCache'
import { localWorktreeFor, prefix, ProviderMark, pullRequestKey } from './pullRequestUtils'

// The views pull in diffs, markdown and filters, so they load when the tab first opens
const PullRequestsView = lazy(() => import('./PullRequests').then((module) => ({ default: module.PullRequestsView })))
const PullRequestDetailView = lazy(() => import('./PullRequests').then((module) => ({ default: module.PullRequestDetailView })))

const TAB_ID = 'prs'

/** A pull request's local worktree on its branch, else the repository checkout */
const checkoutOf = (host: HostApi, pr: PullRequest): string => localWorktreeFor(host.repos, pr) ?? pr.repoPath

/** Callbacks both views take, bound to the host */
function useViewProps(): {
  repos: HostApi['repos']
  diffStyle: HostApi['diffStyle']
  renderSend: (pr: PullRequest) => React.ReactNode
  renderComments: (pr: PullRequest, openFile: (path: string) => void) => React.ReactNode
  onOpenWorktree: (path: string) => void
  onAddToComments: (pr: PullRequest, thread: ReviewThread, patch: FilePatch | undefined) => void
  onAddFile: (pr: PullRequest, patch: FilePatch) => void
  onCreateWorktree: (pr: PullRequest) => void
} {
  const host = useHost()
  return {
    repos: host.repos,
    diffStyle: host.diffStyle,
    renderSend: (pr) => host.renderSendButton(checkoutOf(host, pr), 'pill'),
    renderComments: (pr, openFile) => host.renderCommentsPanel(checkoutOf(host, pr), openFile),
    onOpenWorktree: host.openWorktree,
    onAddToComments: (pr, thread, patch) => {
      const worktreePath = checkoutOf(host, pr)
      const line = thread.line ?? 0
      const range = thread.path ? { start: line, end: line, side: thread.side } : { start: 0, end: 0 }
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        worktreePath,
        filePath: thread.path ?? `${pr.provider === 'github' ? 'PR #' : 'MR !'}${pr.number} conversation`,
        range,
        code: patch && line > 0 ? extractLines(patch.patch, range) : '',
        text: thread.comments.map((entry) => `@${entry.author}: ${entry.body.trim()}`).join('\n\n')
      }
      host.addComment(comment)
      host.flash(`Added to comments on ${baseName(worktreePath)}`)
    },
    // Just the path: the agent reads the file itself
    onAddFile: (pr, patch) => {
      const worktreePath = checkoutOf(host, pr)
      host.addComment({ id: crypto.randomUUID(), worktreePath, filePath: patch.path, range: { start: 0, end: 0 }, code: '', text: '' })
      host.flash(`Added ${baseName(patch.path)} to comments on ${baseName(worktreePath)}`)
    },
    onCreateWorktree: (pr) => {
      host.flash(`Creating worktree for ${pr.sourceBranch}...`)
      host.createWorktree(pr.repoPath, pr.sourceBranch).catch((reason: unknown) => host.flash(errorMessage(reason)))
    }
  }
}

function DetailTab({ pr }: { pr: PullRequest }): React.JSX.Element {
  const host = useHost()
  const props = useViewProps()
  const commentCount = host.comments.filter((comment) => comment.worktreePath === checkoutOf(host, pr)).length
  return (
    <Suspense fallback={null}>
      <PullRequestDetailView key={pullRequestKey(pr)} pr={pr} commentCount={commentCount} {...props} />
    </Suspense>
  )
}

const detailTab = (pr: PullRequest): DocumentTab => ({
  key: `pr:${pullRequestKey(pr)}`,
  title: pr.title,
  icon: (
    <>
      <ProviderMark provider={pr.provider} className="size-3.5" />
      <span className="font-mono text-muted-foreground">
        {prefix(pr)}
        {pr.number}
      </span>
    </>
  ),
  parent: TAB_ID,
  panels: ['terminal'],
  content: <DetailTab pr={pr} />
})

function PullRequestsTab(): React.JSX.Element {
  const host = useHost()
  const props = useViewProps()
  const { bottomPanel } = useSettings()
  const list = (wrapDetail?: (detail: React.ReactNode) => React.ReactNode): React.JSX.Element => (
    <Suspense fallback={<div className="flex-1" />}>
      <PullRequestsView
        {...props}
        wrapDetail={wrapDetail}
        repoPaths={host.scopeRepoPaths}
        scopeLabel={host.scopeLabel}
        onOpenTab={(pr) => host.openTab(detailTab(pr))}
        commentCountFor={(pr) => host.comments.filter((comment) => comment.worktreePath === checkoutOf(host, pr)).length}
      />
    </Suspense>
  )
  // A full-width bottom panel goes under the list too; otherwise only under the pane beside it, like Worktrees
  return <>{bottomPanel === 'full' ? host.withDock(list()) : list(host.withDock)}</>
}

/** Background refresh of the current workspace's pull requests, so the tab opens on fresh data */
function Polling(): null {
  const { scopeRepoPaths } = useHost()
  const { prPollMinutes } = prSettings.use()
  const scopeKey = scopeRepoPaths ? scopeKeyOf(scopeRepoPaths) : ''
  useEffect(() => {
    if (prPollMinutes === 0 || !scopeRepoPaths?.length) return
    const refresh = (): void => void refreshPullRequests(scopeRepoPaths).catch(() => undefined)
    const timer = setInterval(refresh, prPollMinutes * 60_000)
    // Coming back to the app after a while refreshes right away instead of waiting for the next tick
    const onFocus = (): void => {
      if (Date.now() - lastFetched(scopeKey) > prPollMinutes * 60_000) refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [scopeKey, prPollMinutes])
  return null
}

function PullRequestSettings(): React.JSX.Element {
  const { prFilesView, prPollMinutes } = prSettings.use()
  return (
    <>
      <Row label="Files" description="Show one changed file at a time, or scroll through every file like GitHub. Files marked viewed collapse in the scroll.">
        <Segmented
          value={prFilesView}
          options={[
            ['all', 'All files'],
            ['single', 'One file']
          ]}
          onChange={(next) => prSettings.update({ prFilesView: next })}
        />
      </Row>
      <Row label="Refresh in the background" description="Fetch pull requests so the list is up to date when you open it. Uses the gh and glab CLIs.">
        <Segmented
          value={`${prPollMinutes}`}
          options={POLL_MINUTES.map((minutes): [string, string] => [`${minutes}`, minutes === 0 ? 'Off' : `${minutes} min`])}
          onChange={(value) => prSettings.update({ prPollMinutes: POLL_MINUTES.find((minutes) => `${minutes}` === value) ?? 5 })}
        />
      </Row>
    </>
  )
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Pull requests', icon: 'pullRequest', order: 20, render: PullRequestsTab, panels: ['terminal'] }],
  Root: Polling,
  Settings: PullRequestSettings,
  toolMarks: {
    gh: () => <ProviderMark provider="github" className="size-4" />,
    glab: () => <ProviderMark provider="gitlab" className="size-4" />
  }
}

export default plugin
