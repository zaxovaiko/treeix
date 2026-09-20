import { lazy, Suspense, useEffect, useReducer } from 'react'
import { type Command, type DocumentTab, type HostApi, type RendererPlugin, useHost } from '@treeix/sdk'
import { Row, Segmented } from '@treeix/app/settingsUi'
import { baseName } from '@treeix/app/Sidebar'
import { errorMessage } from '@treeix/app/ui'
import type { PullRequest } from '../shared/types'
import { POLL_MINUTES, prSettings } from './api'
import { cachedPullRequests, findCachedPullRequest, lastFetched, onPullRequestsUpdated, refreshPullRequests, scopeKeyOf } from './pullRequestCache'
import { pullRequestCommands } from './keys'
import type { DetailProps } from './PullRequests'
import { localWorktreeFor, prefix, ProviderMark, pullRequestKey, threadReference } from './pullRequestUtils'

// The views pull in diffs, markdown and filters, so they load when the tab first opens
const PullRequestsView = lazy(() => import('./PullRequests').then((module) => ({ default: module.PullRequestsView })))
const PullRequestDetailView = lazy(() => import('./PullRequests').then((module) => ({ default: module.PullRequestDetailView })))

const TAB_ID = 'prs'

/** A pull request's local worktree on its branch, else the repository checkout */
const checkoutOf = (host: HostApi, pr: PullRequest): string => localWorktreeFor(host.repos, pr) ?? pr.repoPath

/** Callbacks both views take, bound to the host */
function useViewProps(): DetailProps {
  const host = useHost()
  return {
    repos: host.repos,
    diffStyle: host.diffStyle,
    renderSend: (pr) => host.renderSendButton(checkoutOf(host, pr), 'pill'),
    renderComments: (pr, openFile) => host.renderCommentsPanel(checkoutOf(host, pr), openFile),
    onOpenWorktree: host.openWorktree,
    // A reference only: the agent reads the thread and the code itself
    onAddToComments: (pr, thread) => {
      const worktreePath = checkoutOf(host, pr)
      const line = thread.line ?? 0
      host.addComment({
        id: crypto.randomUUID(),
        worktreePath,
        filePath: thread.path ?? `${pr.provider === 'github' ? 'PR #' : 'MR !'}${pr.number} conversation`,
        range: thread.path ? { start: line, end: line, side: thread.side } : { start: 0, end: 0 },
        code: '',
        text: threadReference(pr, thread),
        kind: 'reference'
      })
      host.flash(`Added to comments on ${baseName(worktreePath)}`)
    },
    onAddNote: (pr, patch, range, text) => {
      const worktreePath = checkoutOf(host, pr)
      host.addComment({
        id: crypto.randomUUID(),
        worktreePath,
        filePath: patch.path,
        range: range ?? { start: 0, end: 0 },
        code: '',
        text: text.trim()
      })
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

function DetailTab({ pr: opened }: { pr: PullRequest }): React.JSX.Element {
  // The tab keeps the pull request it was opened with; background refreshes bring its title, state and counts up to date
  const [, bump] = useReducer((count: number) => count + 1, 0)
  useEffect(() => onPullRequestsUpdated(bump), [])
  const pr = findCachedPullRequest(opened.url) ?? opened
  const props = useViewProps()
  return (
    <Suspense fallback={null}>
      <PullRequestDetailView key={pullRequestKey(pr)} pr={pr} {...props} />
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
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <PullRequestsView {...props} repoPaths={host.scopeRepoPaths} scopeLabel={host.scopeLabel} onOpenTab={(pr) => host.openTab(detailTab(pr))} />
    </Suspense>
  )
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

/**
 * Opens a pull request link from elsewhere, like a terminal, as a tab. A new one may not be in the list yet,
 * so the workspace's list is fetched once before giving up.
 */
async function openPullRequestUrl(url: string, host: HostApi): Promise<boolean> {
  if (!/\/(pull|merge_requests)\/\d+/.test(url)) return false
  const pr = findCachedPullRequest(url) ?? (host.scopeRepoPaths ? (await refreshPullRequests(host.scopeRepoPaths), findCachedPullRequest(url)) : null)
  if (!pr) return false
  host.openTab(detailTab(pr))
  return true
}

/** The workspace's fetched pull requests in the palette, each opening in its own tab */
const listedCommands = (host: HostApi): Command[] =>
  (cachedPullRequests(scopeKeyOf(host.scopeRepoPaths ?? []))?.pullRequests ?? []).map((pr) => ({
    id: `pr:${pr.url}`,
    group: 'Pull requests',
    label: `${prefix(pr)}${pr.number} ${pr.title}`,
    detail: `${baseName(pr.repoPath)} · ${pr.author} · ${pr.state}`,
    icon: 'pullRequest',
    run: () => host.openTab(detailTab(pr))
  }))

const plugin: RendererPlugin = {
  services: { pullRequests: { open: openPullRequestUrl } },
  tabs: [{ id: TAB_ID, label: 'Pull requests', icon: 'pullRequest', order: 20, render: PullRequestsTab, panels: ['terminal'] }],
  Root: Polling,
  Settings: PullRequestSettings,
  commands: (host) => [...pullRequestCommands(), ...listedCommands(host)],
  toolMarks: {
    gh: () => <ProviderMark provider="github" className="size-4" />,
    glab: () => <ProviderMark provider="gitlab" className="size-4" />
  }
}

export default plugin
