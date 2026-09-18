import { type DiffLineAnnotation, PatchDiff, Virtualizer } from '@pierre/diffs/react'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { LineRange } from '@treeix/shared/comments'
import { type FilePatch, type Repo } from '@treeix/shared/types'
import { type MergeMethod, type PullRequest, type PullRequestComment, type PullRequestDetail, type PullRequestList, type PullRequestState, REACTIONS, type Reaction, type Reviewer, type ReviewThread, type ThreadComment } from '../shared/types'
import { allFolders, ChangedFileList, folderPaths } from '@treeix/app/ChangedFiles'
import { ancestorFolders } from '@treeix/app/fileTree'
import { groupOpen } from '@treeix/app/settings'
import { api, imageResolver, prSettings } from './api'
import { CodeNavigationContext, useSymbolNavigation } from '@treeix/app/codeNavigation'
import { CommandPalette } from '@treeix/app/CommandPalette'
import { cachedPullRequests, onPullRequestsUpdated, refreshPullRequests, scopeKeyOf } from './pullRequestCache'
import { ErrorBoundary } from '@treeix/app/ErrorBoundary'
import { FullFileView } from './FullFileView'
import { isMarkdownPath, MarkdownPreview, PreviewToggle, useMarkdownPreview } from '@treeix/app/MarkdownPreview'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { CommentDraft, orderRange } from '@treeix/app/Comments'
import { codeThemeOptions, diffBackground } from '@treeix/app/FileView'
import { ConflictMark, groupPullRequests, localWorktreeFor, markdownBase, prefix, ProviderMark, pullRequestKey, isPullRequestSort, PULL_REQUEST_SORTS, type PullRequestSort, ReviewMark, reviewSettled, sortPullRequests, STATE_STYLE, StateBadge, timeAgo, UserAvatar } from './pullRequestUtils'
import { FilterSearch, matchesFilters, parseFilters, type PullRequestFilter } from './PullRequestFilter'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import { CopyButton, EmptyState, errorMessage, IconButton, readStored, ResizeHandle, TextPrompt, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import { useHost } from '@treeix/sdk'

const detailCache = new Map<string, PullRequestDetail>()
/** Returning to the app reloads an open pull request at most this often */
const DETAIL_FOCUS_REFRESH_MS = 30_000

export function PullRequestsView({
  repos,
  repoPaths,
  scopeLabel,
  diffStyle,
  onOpenTab,
  onOpenWorktree,
  onAddToComments,
  onAddNote,
  onCreateWorktree,
  wrapDetail = (detail) => detail,
  renderSend,
  renderComments,
  commentCountFor,
  onAddFile
}: {
  renderComments?: (pr: PullRequest, openFile: (path: string) => void) => React.ReactNode
  commentCountFor?: (pr: PullRequest) => number
  onAddFile: (pr: PullRequest, patch: FilePatch) => void
  /** The send-comments-to-agent button for a pull request's checkout */
  renderSend?: (pr: PullRequest) => React.ReactNode
  repos: Repo[] | null
  /** Wraps the pane beside the list, e.g. to dock the terminal under it */
  wrapDetail?: (detail: React.ReactNode) => React.ReactNode
  /** Repositories to query, following the sidebar folder or focus filter */
  repoPaths: string[] | null
  scopeLabel: string
  diffStyle: 'split' | 'unified'
  onOpenTab: (pr: PullRequest) => void
  onOpenWorktree: (worktreePath: string) => void
  onAddToComments: (pr: PullRequest, thread: ReviewThread, patch: FilePatch | undefined) => void
  /** Keeps a drafted note as an agent comment instead of posting it; `range` is null for the whole file */
  onAddNote: (pr: PullRequest, patch: FilePatch, range: LineRange | null, text: string) => void
  onCreateWorktree: (pr: PullRequest) => void
}): React.JSX.Element {
  const scopeKey = repoPaths ? scopeKeyOf(repoPaths) : ''
  const [data, setData] = useState<PullRequestList | null>(() => cachedPullRequests(scopeKey))
  const [loading, setLoading] = useState(false)
  const [provider, setProvider] = usePersisted<'all' | 'github' | 'gitlab'>(workspaceKey('prs.provider'), 'all')
  const [status, setStatus] = usePersisted<PullRequestState>(workspaceKey('prs.state'), 'open')
  const [filters, setFiltersState] = useState<PullRequestFilter[]>(() => parseFilters(readStored(workspaceKey('prs.filters'))))
  const setFilters = (next: PullRequestFilter[]): void => {
    localStorage.setItem(workspaceKey('prs.filters'), JSON.stringify(next))
    setFiltersState(next)
  }
  const [selectedKey, setSelectedKeyState] = useState<string | null>(() => {
    const stored = readStored(workspaceKey('prs.selected'))
    return typeof stored === 'string' ? stored : null
  })
  const setSelectedKey = (key: string | null): void => {
    localStorage.setItem(workspaceKey('prs.selected'), JSON.stringify(key))
    setSelectedKeyState(key)
  }
  const [listWidth, setListWidth] = usePersisted<number>('prs.listWidth', 400)
  const [listOpen, setListOpen] = usePersisted<boolean>(workspaceKey('prs.listOpen'), true)
  const [storedSort, setSort] = usePersisted<string>(workspaceKey('prs.sort'), 'updated')
  const sort: PullRequestSort = isPullRequestSort(storedSort) ? storedSort : 'updated'

  const refresh = (): void => {
    if (!repoPaths) return
    setLoading(true)
    refreshPullRequests(repoPaths).finally(() => setLoading(false))
  }

  // Show what was fetched before straight away and refresh behind it; background polling updates it too
  useEffect(() => {
    setData(cachedPullRequests(scopeKey))
    refresh()
    return onPullRequestsUpdated((updated) => updated === scopeKey && setData(cachedPullRequests(scopeKey)))
  }, [scopeKey])

  const byProvider = (data?.pullRequests ?? []).filter((pr) => provider === 'all' || pr.provider === provider)
  const inScope = byProvider.filter((pr) => matchesFilters(pr, filters))
  const visible = sortPullRequests(inScope.filter((pr) => pr.state === status), sort)
  // Only open pull requests are grouped; merged and closed ones have nothing left to do
  const groups = status === 'open' ? groupPullRequests(visible) : [{ id: 'all', label: '', pullRequests: visible }]
  const selected = visible.find((pr) => pullRequestKey(pr) === selectedKey) ?? groups[0]?.pullRequests[0]

  const row = (pr: PullRequest): React.JSX.Element => {
    const active = selected && pullRequestKey(pr) === pullRequestKey(selected)
    const local = localWorktreeFor(repos, pr)
    const settled = reviewSettled(pr.review)
    return (
      <button
        key={pullRequestKey(pr)}
        onClick={() => setSelectedKey(pullRequestKey(pr))}
        onDoubleClick={() => onOpenTab(pr)}
        onContextMenu={(event) => {
          const addFilter = (filter: PullRequestFilter): void => setFilters([...filters, filter])
          openMenu(event, [
            { label: 'Open in tab', run: () => onOpenTab(pr) },
            { label: `Open on ${providerName(pr)}`, run: () => window.open(pr.url) },
            null,
            local
              ? { label: 'Open local worktree', run: () => onOpenWorktree(local) }
              : { label: `Create worktree for ${pr.sourceBranch}`, enabled: pr.state === 'open', run: () => onCreateWorktree(pr) },
            null,
            { label: 'Copy link', run: () => copyText(pr.url) },
            { label: 'Copy branch name', run: () => copyText(pr.sourceBranch) },
            { label: `Copy ${prefix(pr)}${pr.number}`, run: () => copyText(`${prefix(pr)}${pr.number}`) },
            null,
            { label: `Filter by ${pr.author}`, run: () => addFilter({ kind: 'author', value: pr.author }) },
            { label: `Filter by ${baseName(pr.repoPath)}`, run: () => addFilter({ kind: 'repo', value: pr.repoPath }) }
          ])
        }}
        className={`mb-0.5 block w-full rounded-lg px-2.5 py-2 text-left transition-opacity ${active ? 'bg-accent ring-1 ring-border' : 'hover:bg-accent'} ${
          settled && !active ? 'opacity-50 hover:opacity-90' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <ProviderMark provider={pr.provider} />
          <span className={`min-w-0 flex-1 truncate text-[13px] ${settled ? '' : 'font-medium'}`}>{pr.title}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 pl-6 text-[11.5px] text-muted-foreground">
          <span className="font-mono">
            {prefix(pr)}
            {pr.number}
          </span>
          <span className="truncate">
            {baseName(pr.repoPath)} · {pr.author}
          </span>
          <span className="flex-1" />
          <ConflictMark pr={pr} />
          <ReviewMark review={pr.review} />
          <StateBadge pr={pr} />
        </div>
        <div className="mt-1 flex items-center gap-2 pl-6 text-[11px] text-muted-foreground">
          {pr.additions !== null && <span className="font-mono text-emerald-400">+{pr.additions}</span>}
          {pr.deletions !== null && <span className="font-mono text-red-400">−{pr.deletions}</span>}
          <span className="truncate font-mono">{pr.sourceBranch}</span>
          {local && <span className="shrink-0 text-indigo-300">⎇ local</span>}
          <span className="flex-1" />
          <span>{timeAgo(pr.updatedAt)}</span>
        </div>
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {listOpen && (
      <aside style={{ width: listWidth }} className="relative flex shrink-0 flex-col border-r border-border bg-card">
        <div className="flex flex-col gap-2 p-2.5">
          <div className="flex items-start gap-1.5">
            <FilterSearch pullRequests={byProvider} filters={filters} onChange={setFilters} />
            <button
              title={`Sort: ${PULL_REQUEST_SORTS[sort]}`}
              onClick={(event) =>
                openMenu(
                  event,
                  (Object.keys(PULL_REQUEST_SORTS) as PullRequestSort[]).map((key) => ({
                    label: `${key === sort ? '✓ ' : '    '}${PULL_REQUEST_SORTS[key]}`,
                    run: () => setSort(key)
                  }))
                )
              }
              className={`grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-border hover:text-foreground ${sort === 'updated' ? 'text-muted-foreground' : 'text-primary'}`}
            >
              <Icon name="sort" className="size-3.5" />
            </button>
            <button
              title="Refresh"
              onClick={refresh}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground ring-1 ring-border hover:text-foreground"
            >
              <Icon name="refresh" className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="flex gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
            {(['all', 'github', 'gitlab'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setProvider(value)}
                className={`flex h-6 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] ${
                  provider === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {value !== 'all' && <ProviderMark provider={value} className="size-3" />}
                {{ all: 'All', github: 'GitHub', gitlab: 'GitLab' }[value]}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
            {(['open', 'merged', 'closed'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setStatus(value)}
                className={`h-6 flex-1 rounded-md text-[11px] ${status === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {STATE_STYLE[value].label}{' '}
                <span className="text-muted-foreground tabular-nums">{inScope.filter((pr) => pr.state === value).length}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-1.5">
          {!data && <EmptyState title="Loading pull requests..." />}
          <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">
            {repoPaths?.length ?? 0} {repoPaths?.length === 1 ? 'repository' : 'repositories'} in {scopeLabel}
          </p>
          {data && data.errors.length > 0 && (
            <details className="mx-1 mb-1.5 rounded-md bg-red-400/10 px-2 py-1.5 text-[11px] text-red-400">
              <summary className="cursor-pointer">
                {data.errors.length} {data.errors.length === 1 ? 'repository' : 'repositories'} could not be loaded
              </summary>
              {data.errors.map((error) => (
                <p key={error} className="mt-1 break-words text-red-300/80 select-text">
                  {error}
                </p>
              ))}
            </details>
          )}
          {data && visible.length === 0 && <EmptyState icon="pullRequest" title="No pull requests" />}
          {groups.map((group, index) => (
            <div key={group.id}>
              {groups.length > 1 && (
                <div className={`flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase ${index > 0 ? 'pt-3' : 'pt-1'}`}>
                  {group.label}
                  <span className="tabular-nums text-muted-foreground/60">{group.pullRequests.length}</span>
                </div>
              )}
              {group.pullRequests.map(row)}
            </div>
          ))}
        </div>
        <ResizeHandle width={listWidth} min={300} max={640} onResize={setListWidth} />
      </aside>
      )}

      {wrapDetail(
        selected ? (
          <ErrorBoundary label={`${prefix(selected)}${selected.number}`} resetKey={pullRequestKey(selected)}>
          <PullRequestDetailView
            key={pullRequestKey(selected)}
            renderSend={renderSend}
            renderComments={renderComments}
            commentCount={commentCountFor?.(selected)}
            onAddFile={onAddFile}
            pr={selected}
            repos={repos}
            diffStyle={diffStyle}
            onOpenWorktree={onOpenWorktree}
            onAddToComments={onAddToComments}
            onAddNote={onAddNote}
            onCreateWorktree={onCreateWorktree}
            listOpen={listOpen}
            onToggleList={() => setListOpen(!listOpen)}
          />
          </ErrorBoundary>
        ) : (
          <EmptyState fill icon="pullRequest" title="Select a pull request">
            {!listOpen && (
              <button onClick={() => setListOpen(true)} className="h-7 rounded-md px-2.5 text-xs ring-1 ring-input hover:bg-accent">
                Show pull requests
              </button>
            )}
          </EmptyState>
        )
      )}
    </div>
  )
}

const REACTION_EMOJI: Record<Reaction, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀'
}

const providerName = (pr: PullRequest): string => (pr.provider === 'github' ? 'GitHub' : 'GitLab')

function Reactions({ pr, comment }: { pr: PullRequest; comment: ThreadComment }): React.JSX.Element {
  const [added, setAdded] = useState<Reaction[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fresh counts from a reload already include what was added here
  useEffect(() => setAdded([]), [comment.reactions])

  const count = (reaction: Reaction): number => comment.reactions[reaction] + (added.includes(reaction) ? 1 : 0)
  const react = (reaction: Reaction): void => {
    setPickerOpen(false)
    if (added.includes(reaction)) return
    setError(null)
    setAdded([...added, reaction])
    api.reactToPullRequestComment(pr, comment.id, reaction).catch((reason: unknown) => {
      setAdded((current) => current.filter((candidate) => candidate !== reaction))
      setError(errorMessage(reason))
    })
  }

  return (
    <div className="relative mt-1.5 flex flex-wrap items-center gap-1">
      {REACTIONS.filter((reaction) => count(reaction) > 0).map((reaction) => (
        <button
          key={reaction}
          onClick={() => react(reaction)}
          className={`flex h-6 items-center gap-1 rounded-full px-2 text-xs ring-1 ${
            added.includes(reaction) ? 'bg-primary/15 ring-primary/50' : 'ring-border hover:bg-accent'
          }`}
        >
          {REACTION_EMOJI[reaction]} <span className="text-muted-foreground tabular-nums">{count(reaction)}</span>
        </button>
      ))}
      <button
        title={`React on ${providerName(pr)}`}
        onClick={() => setPickerOpen(!pickerOpen)}
        className="grid size-6 place-items-center rounded-full text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground"
      >
        <Icon name="smilePlus" className="size-3.5" />
      </button>
      {pickerOpen && (
        <div
          onMouseLeave={() => setPickerOpen(false)}
          className="absolute top-7 left-0 z-30 flex gap-0.5 rounded-lg border border-input bg-popover p-1"
        >
          {REACTIONS.map((reaction) => (
            <button key={reaction} onClick={() => react(reaction)} className="grid size-7 place-items-center rounded-md text-base hover:bg-accent">
              {REACTION_EMOJI[reaction]}
            </button>
          ))}
        </div>
      )}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  )
}

/** A branch name that copies itself when clicked */
function BranchCopy({ branch }: { branch: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      title={copied ? 'Copied' : `Copy ${branch}`}
      onClick={() => navigator.clipboard.writeText(branch).then(() => setCopied(true))}
      className="group/branch flex min-w-0 items-center gap-1.5 rounded bg-accent px-1.5 font-mono text-indigo-200 hover:bg-foreground/10"
    >
      <span className="truncate">{branch}</span>
      <Icon name={copied ? 'check' : 'copy'} className={`size-3 shrink-0 ${copied ? 'text-emerald-400' : 'text-muted-foreground group-hover/branch:text-foreground'}`} />
    </button>
  )
}

const REVIEWER_LOOK: Record<Reviewer['state'], { label: string; className: string; icon: 'check' | 'alert' | 'comment' | 'loader' }> = {
  requested: { label: 'Review pending', className: 'text-amber-400', icon: 'loader' },
  approved: { label: 'Approved', className: 'text-emerald-400', icon: 'check' },
  changes: { label: 'Requested changes', className: 'text-red-400', icon: 'alert' },
  commented: { label: 'Commented', className: 'text-muted-foreground', icon: 'comment' }
}

/** Approve, or request changes with a reason; both reload the pull request so the reviewer list shows the new state */
function ReviewButtons({
  pr,
  myReview,
  onReviewed,
  onError
}: {
  pr: PullRequest
  myReview: PullRequestDetail['myReview']
  onReviewed: () => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  /** Your verdict as sent from here, shown before the provider confirms it */
  const [sent, setSent] = useState<PullRequestDetail['myReview']>(null)
  // The dialog's text; it comes back with the same text when sending fails, so nothing typed is lost
  const [reason, setReason] = useState<string | null>(null)
  const shown = sent ?? myReview
  const approve = (): void => {
    setSent('approved')
    api.submitReview(pr, 'approve', '').then(onReviewed, (failure: unknown) => {
      setSent(null)
      onError(`Approval not sent: ${errorMessage(failure)}`)
    })
  }
  const requestChanges = (body: string): Promise<void> => {
    setSent('changes')
    api.submitReview(pr, 'changes', body).then(onReviewed, (failure: unknown) => {
      setSent(null)
      setReason(body)
      onError(`Change request not sent: ${errorMessage(failure)}`)
    })
    return Promise.resolve()
  }
  const [open, setOpen] = useState(false)
  const look =
    shown === 'approved'
      ? { label: 'Approved', className: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30', icon: 'check' as const }
      : shown === 'changes'
        ? { label: 'Changes requested', className: 'bg-red-400/12 text-red-400 ring-red-400/30', icon: 'alert' as const }
        : { label: 'Review', className: 'text-foreground ring-input hover:bg-accent', icon: 'eye' as const }
  const option = (verdict: 'approved' | 'changes', label: string, detail: string, run: () => void): React.JSX.Element => (
    <button
      onClick={() => {
        setOpen(false)
        run()
      }}
      className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent ${shown === verdict ? 'bg-accent' : ''}`}
    >
      <Icon name={verdict === 'approved' ? 'check' : 'alert'} className={`mt-0.5 size-3.5 shrink-0 ${verdict === 'approved' ? 'text-emerald-400' : 'text-red-400'}`} />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium ring-1 ${look.className}`}>
        <Icon name={look.icon} className="size-3" />
        {look.label}
        <Icon name="chevron" className={`size-3 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-40 mt-1 flex w-64 flex-col gap-1 rounded-lg border border-input bg-popover p-1">
            {option('approved', shown === 'approved' ? 'Approved' : 'Approve', "Marks the changes as good to merge", () => shown !== 'approved' && approve())}
            {option('changes', 'Request changes', 'Asks for a reason and blocks the merge', () => setReason(''))}
          </div>
        </>
      )}
      {reason !== null && (
        <TextPrompt
          title="Request changes"
          description={`Tells ${pr.author} what has to change before this can merge.`}
          placeholder="What needs to change"
          confirmLabel="Request changes"
          initialValue={reason}
          onSubmit={requestChanges}
          onClose={() => setReason(null)}
        />
      )}
    </div>
  )
}

const MERGE_METHODS: Record<MergeMethod, { label: string; detail: string }> = {
  merge: { label: 'Merge commit', detail: 'All commits plus a merge commit' },
  squash: { label: 'Squash and merge', detail: 'All changes in one commit' },
  rebase: { label: 'Rebase and merge', detail: 'Commits replayed, no merge commit' }
}
const isMergeMethod = (value: string): value is MergeMethod => Object.hasOwn(MERGE_METHODS, value)

/**
 * Merging can't be undone, so the button opens a small form to pick how and confirm, and waits for the provider
 * instead of showing the result early. The last method used is remembered.
 */
function MergeButton({ pr, onMerged, onError }: { pr: PullRequest; onMerged: () => void; onError: (message: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [storedMethod, setMethod] = usePersisted<string>('prs.mergeMethod', 'squash')
  const method: MergeMethod = isMergeMethod(storedMethod) ? storedMethod : 'squash'
  const [deleteBranch, setDeleteBranch] = usePersisted<boolean>('prs.deleteBranchOnMerge', true)
  const [merging, setMerging] = useState(false)
  const { scopeRepoPaths } = useHost()
  const blocked = pr.conflicts ? 'Resolve the conflicts first' : pr.draft ? 'Drafts can’t be merged' : null
  const merge = (): void => {
    setMerging(true)
    api
      .merge(pr, method, deleteBranch)
      .then(
        () => {
          setOpen(false)
          onMerged()
          // The list moves it to Merged
          void refreshPullRequests(scopeRepoPaths ?? [pr.repoPath]).catch(() => undefined)
        },
        (reason: unknown) => onError(`Not merged: ${errorMessage(reason)}`)
      )
      .finally(() => setMerging(false))
  }
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={blocked !== null}
        title={blocked ?? `Merge into ${pr.targetBranch}`}
        className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[11.5px] font-medium text-white disabled:opacity-40"
      >
        <Icon name="pullRequest" className="size-3" />
        Merge
        <Icon name="chevron" className={`size-3 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => !merging && setOpen(false)} />
          <div className="absolute top-full right-0 z-40 mt-1 w-72 rounded-lg border border-input bg-popover p-1">
            <div className="flex flex-col gap-1">
            {(Object.keys(MERGE_METHODS) as MergeMethod[]).map((candidate) => (
              <button
                key={candidate}
                onClick={() => setMethod(candidate)}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent ${method === candidate ? 'bg-accent' : ''}`}
              >
                <Icon name="check" className={`mt-0.5 size-3.5 shrink-0 text-primary ${method === candidate ? '' : 'invisible'}`} />
                <span>
                  <span className="block text-xs font-medium">{MERGE_METHODS[candidate].label}</span>
                  <span className="block text-[11px] text-muted-foreground">{MERGE_METHODS[candidate].detail}</span>
                </span>
              </button>
            ))}
            </div>
            <hr className="my-1 border-border" />
            <label title={pr.sourceBranch} className="flex items-center gap-2 px-2 py-2 text-xs">
              <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
              Delete source branch after merging
            </label>
            <button
              onClick={merge}
              disabled={merging}
              className="mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-medium text-white disabled:opacity-60"
            >
              {merging && <Icon name="loader" className="size-3.5 animate-spin" />}
              {merging ? 'Merging…' : `${MERGE_METHODS[method].label} into ${pr.targetBranch}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** A reviewer with their state; anyone who already reviewed can be asked to look again */
function ReviewerChip({ reviewer, pr, onRequested, onError }: { reviewer: Reviewer; pr: PullRequest; onRequested: () => Promise<void>; onError: (message: string) => void }): React.JSX.Element {
  // Shown as requested straight away; put back if the provider refuses
  const [requested, setRequested] = useState(false)
  const state = requested ? 'requested' : reviewer.state
  const look = REVIEWER_LOOK[state]
  const request = (): void => {
    setRequested(true)
    api.requestReview(pr, reviewer.login).then(onRequested, (reason: unknown) => {
      setRequested(false)
      onError(`Review request to ${reviewer.login} not sent: ${errorMessage(reason)}`)
    })
  }
  return (
    <span title={`${reviewer.login} · ${look.label}`} className="flex h-6 items-center gap-1.5 rounded-full bg-accent py-0.5 pr-1 pl-0.5 ring-1 ring-border">
      <UserAvatar name={reviewer.login} url={reviewer.avatarUrl} size="size-5" />
      <span className="max-w-40 truncate">{reviewer.login}</span>
      <Icon name={look.icon} className={`size-3 shrink-0 ${look.className}`} />
      {state !== 'requested' && (
        <button
          onClick={request}
          title={`Re-request review from ${reviewer.login}`}
          className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Icon name="refresh" className="size-3" />
        </button>
      )}
    </span>
  )
}

/** A reply or comment shown before the provider has it; kept with Retry and Discard when sending fails */
type PendingComment = { id: string; threadId: string | null; body: string; error: string | null }

function PendingCommentView({ comment, onRetry, onDiscard }: { comment: PendingComment; onRetry: () => void; onDiscard: () => void }): React.JSX.Element {
  return (
    <div className={`flex gap-2.5 border-b border-border px-3 py-2.5 ${comment.error ? 'bg-red-400/5' : 'opacity-60'}`}>
      <div className="size-[22px] shrink-0 rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          {comment.error ? (
            <>
              <span className="min-w-0 flex-1 break-words text-red-400 select-text">Not sent: {comment.error}</span>
              <button onClick={onRetry} className="shrink-0 rounded px-1.5 font-medium text-foreground hover:bg-accent">
                Retry
              </button>
              <button onClick={onDiscard} className="shrink-0 rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                Discard
              </button>
            </>
          ) : (
            <span className="text-muted-foreground">Sending…</span>
          )}
        </div>
        <p className="mt-1 text-[13px] whitespace-pre-wrap select-text">{comment.body}</p>
      </div>
    </div>
  )
}

function ThreadCard({
  thread,
  pr,
  onAdd,
  onReply,
  onResolve,
  pending = [],
  onRetry,
  onDiscard,
  viewer = null,
  onEdit,
  onDelete
}: {
  thread: ReviewThread
  pr: PullRequest
  onAdd: () => void
  onReply: (body: string) => Promise<void>
  onResolve: (resolved: boolean) => void
  pending?: PendingComment[]
  onRetry?: (comment: PendingComment) => void
  onDiscard?: (comment: PendingComment) => void
  /** Your login; your own comments can be edited and deleted */
  viewer?: string | null
  onEdit?: (comment: ThreadComment, body: string) => void
  onDelete?: (comment: ThreadComment) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const remove = (comment: ThreadComment): void => {
    if (window.confirm(`Delete this comment on ${providerName(pr)}?`)) onDelete?.(comment)
  }
  const toggleResolved = (): void => onResolve(!thread.resolved)
  const [added, setAdded] = useState(false)
  const [replying, setReplying] = useState(false)
  const addToComments = (): void => {
    onAdd()
    setAdded(true)
  }
  return (
    <div className={`mx-3 my-2 overflow-hidden rounded-lg border border-border bg-card font-sans text-[13px] text-foreground ${thread.resolved ? 'opacity-70' : ''}`}>
      {thread.resolved && (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11.5px] text-emerald-400">
          <Icon name="check" className="size-3" />
          Resolved
        </div>
      )}
      {thread.comments.map((comment) => {
        const mine = viewer !== null && comment.author === viewer && onEdit !== undefined
        return (
        <div
          key={comment.id}
          className="group/comment flex gap-2.5 border-b border-border px-3 py-2.5"
          onContextMenu={(event) =>
            openMenu(event, [
              { label: 'Copy comment', run: () => copyText(comment.body) },
              mine && { label: 'Edit comment', run: () => setEditing({ id: comment.id, body: comment.body }) },
              mine && { label: 'Delete comment', run: () => remove(comment) },
              { label: `Copy @${comment.author}`, run: () => copyText(`@${comment.author}`) },
              null,
              { label: added ? 'Added to agent comments' : 'Add thread to agent comments', enabled: !added, run: addToComments },
              { label: `Reply on ${providerName(pr)}`, run: () => setReplying(true) },
              { label: `Open on ${providerName(pr)}`, run: () => window.open(pr.url) }
            ])
          }
        >
          <UserAvatar name={comment.author} url={comment.avatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{comment.author}</span>
              <span className="text-muted-foreground">{timeAgo(comment.createdAt)} ago</span>
              <span className="flex-1" />
              {mine && editing?.id !== comment.id && (
                <span className="flex gap-0.5 opacity-0 transition-opacity group-hover/comment:opacity-100">
                  <IconButton label="Edit comment" onClick={() => setEditing({ id: comment.id, body: comment.body })}>
                    <Icon name="pencil" className="size-3" />
                  </IconButton>
                  <IconButton label="Delete comment" onClick={() => remove(comment)}>
                    <Icon name="trash" className="size-3" />
                  </IconButton>
                </span>
              )}
            </div>
            {editing?.id === comment.id ? (
              <div className="mt-1.5">
                <textarea
                  autoFocus
                  value={editing.body}
                  onChange={(event) => setEditing({ id: comment.id, body: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(null)
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && editing.body.trim()) {
                      onEdit?.(comment, editing.body.trim())
                      setEditing(null)
                    }
                  }}
                  rows={Math.min(12, Math.max(3, editing.body.split('\n').length + 1))}
                  className="w-full resize-y rounded-md bg-muted px-2.5 py-2 text-[13px] ring-1 ring-border outline-none focus:ring-primary/60"
                />
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <span className="mr-auto text-[11px] text-muted-foreground">⌘↵ to save, Esc to cancel</span>
                  <button onClick={() => setEditing(null)} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                    Cancel
                  </button>
                  <button
                    disabled={!editing.body.trim() || editing.body.trim() === comment.body}
                    onClick={() => {
                      onEdit?.(comment, editing.body.trim())
                      setEditing(null)
                    }}
                    className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 max-h-[32rem] overflow-y-auto">
                <Markdown baseUrl={markdownBase(pr)} resolveImage={imageResolver(pr)}>
                  {comment.body}
                </Markdown>
              </div>
            )}
            <Reactions pr={pr} comment={comment} />
          </div>
        </div>
        )
      })}
      {pending.map((comment) => (
        <PendingCommentView key={comment.id} comment={comment} onRetry={() => onRetry?.(comment)} onDiscard={() => onDiscard?.(comment)} />
      ))}
      {replying && (
        <CommentDraft
          label={`Reply on ${providerName(pr)}`}
          placeholder="Write a reply"
          submitLabel={`Reply on ${providerName(pr)}`}
          allowAttachments={false}
          onCancel={() => setReplying(false)}
          onSave={(body) => onReply(body).then(() => setReplying(false))}
        />
      )}
      {/* Narrow panes wrap whole buttons onto a new line instead of breaking their labels */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          onClick={addToComments}
          disabled={added}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-white disabled:opacity-60"
        >
          <Icon name={added ? 'check' : 'comment'} className="size-3" />
          {added ? 'Added to comments' : 'Add to agent comments'}
        </button>
        {!replying && (
          <button
            onClick={() => setReplying(true)}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap text-muted-foreground ring-1 ring-border hover:text-foreground"
          >
            <ProviderMark provider={pr.provider} className="size-3.5" />
            Reply
          </button>
        )}
        {thread.resolved !== null && (
          <button
            onClick={toggleResolved}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap text-muted-foreground ring-1 ring-border hover:text-foreground"
          >
            <Icon name="check" className="size-3" />
            {thread.resolved ? 'Unresolve' : 'Resolve conversation'}
          </button>
        )}
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:text-foreground"
        >
          <ProviderMark provider={pr.provider} className="size-3.5" />
          Open on {providerName(pr)} <Icon name="external" className="size-3" />
        </a>
      </div>
    </div>
  )
}

export function PullRequestDetailView({
  pr,
  repos,
  diffStyle,
  onOpenWorktree,
  onAddToComments,
  onAddNote,
  onCreateWorktree,
  renderSend,
  renderComments,
  commentCount = 0,
  onAddFile,
  listOpen,
  onToggleList
}: {
  /** The agent comments panel for this pull request's checkout; `openFile` jumps to a commented file */
  renderComments?: (pr: PullRequest, openFile: (path: string) => void) => React.ReactNode
  commentCount?: number
  /** Adds a changed file's path to the agent comments */
  onAddFile: (pr: PullRequest, patch: FilePatch) => void
  /** Set when the pull request list sits beside this view and can be hidden */
  listOpen?: boolean
  onToggleList?: () => void
  pr: PullRequest
  repos: Repo[] | null
  diffStyle: 'split' | 'unified'
  renderSend?: (pr: PullRequest) => React.ReactNode
  onOpenWorktree: (worktreePath: string) => void
  onAddToComments: (pr: PullRequest, thread: ReviewThread, patch: FilePatch | undefined) => void
  /** Keeps a drafted note as an agent comment instead of posting it; `range` is null for the whole file */
  onAddNote: (pr: PullRequest, patch: FilePatch, range: LineRange | null, text: string) => void
  onCreateWorktree: (pr: PullRequest) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<PullRequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Each pull request reopens on the tab and file it was left on
  const placeKey = `prs.place:${pr.url}`
  const savedPlace = ((): { view: 'conversation' | 'files'; filePath: string | null } => {
    const stored = readStored(placeKey)
    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
    return { view: record.view === 'files' ? 'files' : 'conversation', filePath: typeof record.filePath === 'string' ? record.filePath : null }
  })()
  const [view, setView] = useState<'conversation' | 'files'>(savedPlace.view)
  const [filePath, setFilePath] = useState<string | null>(savedPlace.filePath)
  useEffect(() => localStorage.setItem(placeKey, JSON.stringify({ view, filePath })), [view, filePath])
  /** The file a comment draft belongs to; in the all-files scroll every file can take one */
  const [draftPath, setDraftPath] = useState<string | null>(null)
  /** Last file under the pointer, which symbol navigation resolves against in the all-files scroll */
  const [pointerPath, setPointerPath] = useState<string | null>(null)
  const [viewed, setViewed] = useState<Set<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [fullFile, setFullFile] = useState<string | null>(null)
  const [addedFiles, setAddedFiles] = useState<Set<string>>(new Set())
  /** The file with an open whole-file comment draft */
  const [fileCommentPath, setFileCommentPath] = useState<string | null>(null)
  const [commentsOpen, setCommentsOpen] = usePersisted<boolean>(workspaceKey('prs.commentsOpen'), false)
  const [commentsWidth, setCommentsWidth] = usePersisted<number>('prs.commentsWidth', 320)
  const { prFilesView } = prSettings.use()
  const allFiles = prFilesView === 'all'
  const [draft, setDraft] = useState<LineRange | null>(null)
  const [composing, setComposing] = useState(false)
  const [groupFiles, setGroupFiles] = usePersisted<boolean>(workspaceKey('prs.groupFiles'), true)
  const folderToggles = useState<Set<string>>(new Set())
  const [toggledFolders, setToggledFolders] = folderToggles
  const [filesWidth, setFilesWidth] = usePersisted<number>('prs.filesWidth', 300)
  const [markdownPreview, setMarkdownPreview] = useMarkdownPreview()
  const local = localWorktreeFor(repos, pr)
  // A worktree on the PR branch matches the diff line for line; otherwise the repo checkout can only be searched by name
  const outerNavigation = useContext(CodeNavigationContext)
  const navigation = outerNavigation && { ...outerNavigation, worktreePath: local ?? pr.repoPath, exact: local !== null }
  const noNavigation = (): void => undefined

  const load = (): Promise<void> =>
    api.pullRequestDetail(pr).then((result) => {
      detailCache.set(pr.url, result)
      setDetail(result)
      setFilePath((current) => current ?? result.patches[0]?.path ?? null)
    })

  useEffect(() => {
    const cachedDetail = detailCache.get(pr.url)
    setDetail(cachedDetail ?? null)
    setFilePath(savedPlace.filePath ?? cachedDetail?.patches[0]?.path ?? null)
    setError(null)
    load().catch((reason: unknown) => cachedDetail === undefined && setError(errorMessage(reason)))
  }, [pr.url])

  // New commits or comments bump updatedAt in the background list refresh; coming back to the app checks again
  const loadedFor = useRef(pr.updatedAt)
  useEffect(() => {
    if (loadedFor.current === pr.updatedAt) return
    loadedFor.current = pr.updatedAt
    load().catch(() => undefined)
  }, [pr.updatedAt])
  useEffect(() => {
    let last = Date.now()
    const onFocus = (): void => {
      if (Date.now() - last < DETAIL_FOCUS_REFRESH_MS) return
      last = Date.now()
      load().catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pr.url])

  useEffect(() => setDraft(null), [filePath])

  /** Posts, then reloads so the new comment shows with its real id */
  const post = async (comment: PullRequestComment): Promise<void> => {
    await api.commentOnPullRequest(pr, comment)
    await load()
  }

  const patches = detail?.patches ?? []
  const folders = useMemo(() => folderPaths(patches), [patches])
  const allFoldersOpen = folders.every((folder) => groupOpen(toggledFolders, folder))
  // GitHub reports viewed files; GitLab has no API for it, so they are kept on this machine per pull request
  const localViewedKey = `prs.viewed:${pr.url}`
  useEffect(() => {
    if (!detail) return
    if (detail.viewedFiles) return setViewed(new Set(detail.viewedFiles))
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(localViewedKey) ?? '[]')
      setViewed(new Set(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === 'string') : []))
    } catch {
      setViewed(new Set())
    }
  }, [detail])

  const toggleViewed = (path: string): void => {
    const next = new Set(viewed)
    const nowViewed = !next.has(path)
    if (nowViewed) next.add(path)
    else next.delete(path)
    setViewed(next)
    if (nowViewed) {
      // Carry on to the next unviewed file below, wrapping to the top, like working through a review
      const index = patches.findIndex((patch) => patch.path === path)
      const ordered = [...patches.slice(index + 1), ...patches.slice(0, index)]
      const upcoming = ordered.find((patch) => !next.has(patch.path))
      if (upcoming) openFile(upcoming.path)
    }
    if (detail?.viewedFiles) {
      // Optimistic: put the checkbox back if GitHub refuses
      api.setFileViewed(pr, path, nowViewed).catch((reason: unknown) => {
        setViewed(viewed)
        setError(errorMessage(reason))
      })
    } else {
      localStorage.setItem(localViewedKey, JSON.stringify([...next]))
    }
  }

  const [showResolved, setShowResolved] = usePersisted<boolean>(workspaceKey('prs.showResolved'), false)
  /** Resolve and unresolve clicks shown before the provider confirms them, by thread id */
  const [resolvedNow, setResolvedNow] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<PendingComment[]>([])
  useEffect(() => setResolvedNow({}), [detail])
  /** Edits and deletes of your own comments, shown before the provider confirms them */
  const [commentChanges, setCommentChanges] = useState<Record<string, string | null>>({})
  useEffect(() => setCommentChanges({}), [detail])
  const allThreads = (detail?.threads ?? [])
    .map((thread) => ({
      ...(thread.id in resolvedNow ? { ...thread, resolved: resolvedNow[thread.id] } : thread),
      comments: thread.comments
        .filter((comment) => commentChanges[comment.id] !== null)
        .map((comment) => (typeof commentChanges[comment.id] === 'string' ? { ...comment, body: commentChanges[comment.id] ?? comment.body } : comment))
    }))
    .filter((thread) => thread.comments.length > 0)
  const changeComment = (comment: ThreadComment, body: string | null): void => {
    setCommentChanges((current) => ({ ...current, [comment.id]: body }))
    ;(body === null ? api.deleteComment(pr, comment.id) : api.editComment(pr, comment.id, body)).then(load, (reason: unknown) => {
      setCommentChanges(({ [comment.id]: _dropped, ...rest }) => rest)
      setError(`Comment not ${body === null ? 'deleted' : 'saved'}: ${errorMessage(reason)}`)
    })
  }
  const resolvedCount = allThreads.filter((thread) => thread.resolved).length
  // Resolved conversations are done; they stay out of the way unless asked for
  const threads = showResolved ? allThreads : allThreads.filter((thread) => !thread.resolved)
  const file = patches.find((patch) => patch.path === filePath)
  const symbols = useSymbolNavigation({
    worktreePath: local ?? pr.repoPath,
    path: (allFiles ? pointerPath : null) ?? file?.path ?? '',
    exact: local !== null,
    onNavigate: navigation?.onNavigate ?? noNavigation
  })
  const openThread = (thread: ReviewThread): void => {
    if (!thread.path) return
    setFilePath(thread.path)
    setView('files')
  }
  const add = (thread: ReviewThread): void => onAddToComments(pr, thread, patches.find((patch) => patch.path === thread.path))
  const resolve = (thread: ReviewThread, resolved: boolean): void => {
    setResolvedNow((current) => ({ ...current, [thread.id]: resolved }))
    api.setThreadResolved(pr, thread, resolved).then(load, (reason: unknown) => {
      setResolvedNow(({ [thread.id]: _dropped, ...rest }) => rest)
      setError(`Conversation not ${resolved ? 'resolved' : 'reopened'}: ${errorMessage(reason)}`)
    })
  }
  /** Replies and comments show at once as "Sending…"; the draft closes, and a failure keeps the text with Retry */
  const send = (comment: PendingComment): void => {
    setPending((current) => [...current.filter((entry) => entry.id !== comment.id), { ...comment, error: null }])
    api
      .commentOnPullRequest(pr, comment.threadId ? { body: comment.body, threadId: comment.threadId } : { body: comment.body })
      .then(load)
      .then(
        () => setPending((current) => current.filter((entry) => entry.id !== comment.id)),
        (reason: unknown) => setPending((current) => current.map((entry) => (entry.id === comment.id ? { ...entry, error: errorMessage(reason) } : entry)))
      )
  }
  const sendNew = (body: string, threadId: string | null): Promise<void> => {
    send({ id: crypto.randomUUID(), threadId, body, error: null })
    return Promise.resolve()
  }
  const discard = (comment: PendingComment): void => setPending((current) => current.filter((entry) => entry.id !== comment.id))
  const threadCard = (thread: ReviewThread): React.JSX.Element => (
    <ThreadCard
      thread={thread}
      pr={pr}
      onAdd={() => add(thread)}
      onReply={(body) => sendNew(body, thread.id)}
      onResolve={(resolved) => resolve(thread, resolved)}
      pending={pending.filter((comment) => comment.threadId === thread.id)}
      onRetry={send}
      onDiscard={discard}
      viewer={detail?.viewer ?? null}
      onEdit={(comment, body) => changeComment(comment, body)}
      onDelete={(comment) => changeComment(comment, null)}
    />
  )
  // In the all-files scroll, go back to the file this pull request was left on once its diff has loaded
  const restoredScroll = useRef(false)
  useEffect(() => {
    if (!detail || restoredScroll.current || !allFiles || view !== 'files' || !savedPlace.filePath) return
    restoredScroll.current = true
    openFile(savedPlace.filePath)
  }, [detail, view])

  // ⌘P goes to a changed file, like VS Code's quick open
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.key !== 'p' || !detail) return
      event.preventDefault()
      setView('files')
      setPickerOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  const readPullRequestFile = (path: string): Promise<string | null> => (local ? window.api.readFile(local, path) : api.pullRequestFile(pr, path))

  const openFile = (path: string): void => {
    setFilePath(path)
    if (!allFiles) return
    // Scroll the virtualized list by hand: scrollIntoView would also shift overflow-hidden ancestors
    requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>('.pr-files-scroll')
      const section = scroller?.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(path)}"]`)
      if (scroller && section) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
  }

  const renderFile = (patch: FilePatch): React.JSX.Element => {
    const isViewed = viewed.has(patch.path)
    // Like GitHub, viewed files fold away in the scroll; in single-file view the open file always shows
    const collapsed = allFiles && isViewed
    const preview = markdownPreview && isMarkdownPath(patch.path)
    const fileThreads = threads.filter((thread) => thread.path === patch.path && thread.line !== null)
    const fileDraft = draftPath === patch.path ? draft : null
    const annotations: DiffLineAnnotation<{ threadId: string | null }>[] = [
      ...fileThreads.map((thread) => ({ side: thread.side, lineNumber: thread.line ?? 0, metadata: { threadId: thread.id } })),
      ...(fileDraft ? [{ side: fileDraft.endSide ?? fileDraft.side ?? ('additions' as const), lineNumber: fileDraft.end, metadata: { threadId: null } }] : [])
    ]
    const startDraft = (range: LineRange): void => {
      setDraftPath(patch.path)
      setDraft(orderRange(range))
    }
    return (
      <section key={patch.path} data-file-path={patch.path} onPointerEnter={() => setPointerPath(patch.path)} className={allFiles ? 'border-b border-border' : ''}>
        <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-border bg-background pr-2 pl-4 font-mono text-xs text-foreground/85">
          <span className="min-w-0 shrink truncate">{patch.path}</span>
          {allFiles && (
            <span className="shrink-0 font-sans text-[11px] tabular-nums">
              <span className="text-emerald-400">+{patch.additions}</span> <span className="text-red-400">−{patch.deletions}</span>
            </span>
          )}
          {/* The hint gives way first, so the Viewed checkbox stays visible in narrow panes */}
          <span className="ml-auto min-w-0 shrink-[2] truncate font-sans text-[11px] text-muted-foreground">
            {!collapsed && preview ? `Rendered from ${pr.sourceBranch}` : ''}
          </span>
          {isMarkdownPath(patch.path) && !collapsed && <PreviewToggle on={markdownPreview} onChange={setMarkdownPreview} />}
          <button
            onClick={() => setFileCommentPath(fileCommentPath === patch.path ? null : patch.path)}
            title={`Comment on the whole file on ${providerName(pr)}`}
            className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground ${fileCommentPath === patch.path ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            <Icon name="plus" className="size-3.5" />
          </button>
          <button
            onClick={() => {
              onAddFile(pr, patch)
              setAddedFiles(new Set(addedFiles).add(patch.path))
            }}
            title={addedFiles.has(patch.path) ? 'Added to agent comments' : 'Add this file path to agent comments'}
            className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent ${addedFiles.has(patch.path) ? 'text-emerald-400' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon name={addedFiles.has(patch.path) ? 'check' : 'comment'} className="size-3.5" />
          </button>
          <button
            onClick={() => setFullFile(patch.path)}
            title={`View the whole file at ${pr.sourceBranch}`}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="file" className="size-3.5" />
          </button>
          <button
            onClick={() => toggleViewed(patch.path)}
            title={detail?.viewedFiles ? `Marks the file viewed on ${providerName(pr)}` : 'Remembered on this machine; GitLab has no API for viewed files'}
            className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 font-sans text-[11.5px] ring-1 ${
              isViewed ? 'bg-emerald-400/12 text-emerald-400 ring-emerald-400/30' : 'text-muted-foreground ring-border hover:text-foreground'
            }`}
          >
            <span className={`grid size-3.5 place-items-center rounded-sm ${isViewed ? 'bg-emerald-400 text-background' : 'ring-1 ring-input'}`}>
              {isViewed && <Icon name="check" className="size-2.5" />}
            </span>
            Viewed
          </button>
        </div>
        {fileCommentPath === patch.path && (
          <CommentDraft
            label={`Comment on ${baseName(patch.path)} · posts to ${providerName(pr)}`}
            placeholder="Write a comment about the whole file"
            submitLabel={`Comment on ${providerName(pr)}`}
            allowAttachments={false}
            onCancel={() => setFileCommentPath(null)}
            alternative={{
              label: 'Add to agent comments',
              onSave: (text) => {
                onAddNote(pr, patch, null, text)
                setFileCommentPath(null)
              }
            }}
            onSave={(body) => post({ body, path: patch.path }).then(() => setFileCommentPath(null))}
          />
        )}
        {/* Whole-file threads have no line to anchor to, so they sit above the diff */}
        {!collapsed && threads.filter((thread) => thread.path === patch.path && thread.line === null).map((thread) => <div key={thread.id}>{threadCard(thread)}</div>)}
        {collapsed ? null : preview ? (
          <MarkdownPreview
            loadKey={`${pullRequestKey(pr)}:${patch.path}`}
            // A checkout of the PR branch is instant; otherwise the file comes from the provider
            load={() => readPullRequestFile(patch.path)}
          />
        ) : (
          <PatchDiff
            key={patch.path}
            patch={patch.patch}
            className="block"
            style={diffBackground()}
            lineAnnotations={annotations}
            selectedLines={fileDraft}
            renderAnnotation={({ metadata }) => {
              const thread = fileThreads.find((candidate) => candidate.id === metadata.threadId)
              if (thread) return threadCard(thread)
              return fileDraft ? (
                <CommentDraft
                  label={`Comment on line ${fileDraft.end} · posts to ${providerName(pr)}`}
                  placeholder="Write a review comment"
                  submitLabel={`Comment on ${providerName(pr)}`}
                  allowAttachments={false}
                  onCancel={() => setDraft(null)}
                  alternative={{
                    label: 'Add to agent comments',
                    onSave: (text) => {
                      onAddNote(pr, patch, fileDraft, text)
                      setDraft(null)
                    }
                  }}
                  onSave={(body) =>
                    post({ body, path: patch.path, line: fileDraft.end, side: fileDraft.endSide ?? fileDraft.side }).then(() => setDraft(null))
                  }
                />
              ) : null
            }}
            options={{
              ...codeThemeOptions(),
              diffStyle,
              disableFileHeader: true,
              enableLineSelection: true,
              enableGutterUtility: true,
              onGutterUtilityClick: startDraft,
              onLineSelectionEnd: (range) => range && startDraft(range),
              ...symbols.tokenOptions
            }}
          />
        )}
      </section>
    )
  }

  const resolvedToggle =
    resolvedCount > 0 ? (
      <button onClick={() => setShowResolved(!showResolved)} className="mx-3 mt-3 text-xs text-muted-foreground hover:text-foreground">
        {showResolved ? `Hide ${resolvedCount} resolved` : `Show ${resolvedCount} resolved conversation${resolvedCount === 1 ? '' : 's'}`}
      </button>
    ) : null

  return (
    <CodeNavigationContext.Provider value={navigation}>
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The comments panel has its own send button at the bottom, which this pill would cover */}
      {renderSend && !(commentsOpen && renderComments) && <div className="absolute right-4 bottom-4 z-30">{renderSend(pr)}</div>}
      {pickerOpen && (
        <CommandPalette
          browseFiles
          placeholder="Go to file: type or paste a path"
          onClose={() => setPickerOpen(false)}
          commands={patches.map((patch) => ({
            id: patch.path,
            group: 'Files' as const,
            label: baseName(patch.path),
            detail: patch.path,
            filePath: patch.path,
            run: () => openFile(patch.path)
          }))}
        />
      )}
      {fullFile && (
        <FullFileView path={fullFile} subtitle={`at ${pr.sourceBranch}`} load={() => readPullRequestFile(fullFile)} onClose={() => setFullFile(null)} />
      )}
      <div className="shrink-0 border-b border-border px-5 pt-3.5">
        <div className="flex items-center gap-2.5">
          {onToggleList && (
            <span className="-ml-2 flex">
              <IconButton label={listOpen ? 'Hide pull request list' : 'Show pull request list'} active={listOpen} onClick={onToggleList}>
                <Icon name="panel" />
              </IconButton>
            </span>
          )}
          <ProviderMark provider={pr.provider} />
          <h1 className="min-w-0 truncate text-base font-semibold select-text">{pr.title}</h1>
          <span className="shrink-0 font-mono text-[15px] text-muted-foreground">
            {prefix(pr)}
            {pr.number}
          </span>
          <span className="flex-1" />
          {local && (
            <button onClick={() => onOpenWorktree(local)} className="h-7 shrink-0 rounded-md px-2.5 text-xs ring-1 ring-input hover:bg-accent">
              ⎇ Open worktree
            </button>
          )}
          {renderComments && (
            <button
              onClick={() => setCommentsOpen(!commentsOpen)}
              title={commentsOpen ? 'Hide agent comments' : 'Show agent comments'}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-input hover:bg-accent ${commentsOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              <Icon name="comment" className="size-3.5" />
              {commentCount > 0 && <span className="tabular-nums">{commentCount}</span>}
            </button>
          )}
          <span className="flex shrink-0 rounded-md ring-1 ring-input">
            <CopyButton label="Copy pull request link" className="size-3.5" text={() => pr.url} />
          </span>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-input hover:bg-accent"
          >
            <ProviderMark provider={pr.provider} className="size-3.5" />
            {providerName(pr)} <Icon name="external" className="size-3" />
          </a>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <StateBadge pr={pr} />
          <ReviewMark review={pr.review} />
          <ConflictMark pr={pr} />
          <span>{pr.author} wants to merge</span>
          <BranchCopy branch={pr.sourceBranch} />
          <span>into</span>
          <BranchCopy branch={pr.targetBranch} />
          <span>· {baseName(pr.repoPath)}</span>
        </div>
        {/* Details from a main process older than the reviewer list have none */}
        {(detail?.reviewers ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="mr-1 text-muted-foreground">Reviewers</span>
            {(detail?.reviewers ?? []).map((reviewer) => (
              <ReviewerChip key={reviewer.login} reviewer={reviewer} pr={pr} onRequested={load} onError={(message) => setError(message)} />
            ))}
          </div>
        )}
        <div className="mt-1.5 flex gap-5">
          {(['conversation', 'files'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setView(tab)}
              className={`flex h-9 items-center gap-1.5 border-b-2 text-[13px] ${
                view === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'conversation' ? 'Conversation' : 'Files changed'}
              <span className="rounded-full bg-accent px-1.5 text-[11px] tabular-nums">
                {tab === 'conversation' ? threads.reduce((sum, thread) => sum + thread.comments.length, 0) : patches.length}
              </span>
            </button>
          ))}
          {pr.state === 'open' && (
            <div className="ml-auto flex items-center gap-2 self-center">
              <ReviewButtons pr={pr} myReview={detail?.myReview ?? null} onReviewed={load} onError={(message) => setError(message)} />
              <MergeButton
                pr={pr}
                onError={(message) => setError(message)}
                onMerged={load}
              />
            </div>
          )}
        </div>
      </div>

      {error && <p className="m-5 rounded-md bg-red-400/10 px-3 py-2 text-xs text-red-400">{error}</p>}
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!detail && !error && <EmptyState fill title="Loading..." />}

      {detail && view === 'conversation' && (
        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <div className="mx-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Description</div>
            <div className="mt-2">
              {detail.body ? (
                <Markdown baseUrl={markdownBase(pr)} resolveImage={imageResolver(pr)}>
                  {detail.body}
                </Markdown>
              ) : (
                <p className="text-[13px] text-muted-foreground">No description</p>
              )}
            </div>
          </div>
          <div className="mx-3">
            <LinkPreviews urls={detail.body.match(/https?:\/\/[^\s)<>\]"']+/g) ?? []} />
          </div>
          {resolvedToggle}
          {threads.map((thread) => (
            <div key={thread.id}>
              {thread.path && (
                <button onClick={() => openThread(thread)} className="mx-3 mt-4 font-mono text-xs text-indigo-300 hover:underline">
                  {thread.path}
                  {thread.line !== null && `:${thread.line}`}
                </button>
              )}
              {threadCard(thread)}
            </div>
          ))}
          {pending.some((comment) => comment.threadId === null) && (
            <div className="mx-3 my-2 overflow-hidden rounded-lg border border-border bg-card">
              {pending
                .filter((comment) => comment.threadId === null)
                .map((comment) => (
                  <PendingCommentView key={comment.id} comment={comment} onRetry={() => send(comment)} onDiscard={() => discard(comment)} />
                ))}
            </div>
          )}
          {composing ? (
            <CommentDraft
              label={`New comment on ${providerName(pr)}`}
              placeholder="Write a comment"
              submitLabel={`Comment on ${providerName(pr)}`}
              allowAttachments={false}
              onCancel={() => setComposing(false)}
              onSave={(body) => sendNew(body, null).then(() => setComposing(false))}
            />
          ) : (
            <button
              onClick={() => setComposing(true)}
              className="mx-3 mt-3 flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground"
            >
              <ProviderMark provider={pr.provider} className="size-3.5" />
              Comment on {providerName(pr)}
            </button>
          )}
        </div>
      )}

      {detail && view === 'files' && (
        <div className="flex min-h-0 flex-1">
          <nav style={{ width: filesWidth }} className="relative flex shrink-0 flex-col border-r border-border">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-[11px] text-muted-foreground">
              <span className="font-medium" title={`Click a line number in a diff to comment on ${providerName(pr)}`}>
                {patches.length} files
              </span>
              <span className="flex-1" />
              {groupFiles && folders.length > 0 && (
                <button
                  title={allFoldersOpen ? 'Collapse folders except the open file' : 'Expand all folders'}
                  onClick={() => setToggledFolders(allFolders(folders, !allFoldersOpen, filePath ? ancestorFolders(filePath) : []))}
                  className="grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground"
                >
                  <Icon name={allFoldersOpen ? 'collapseAll' : 'expandAll'} className="size-3.5" />
                </button>
              )}
              <button
                title={groupFiles ? 'Show as flat list' : 'Group by folder'}
                onClick={() => setGroupFiles(!groupFiles)}
                className={`grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground ${groupFiles ? 'text-foreground' : ''}`}
              >
                <Icon name={groupFiles ? 'folder' : 'list'} className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <ChangedFileList
                patches={patches}
                activePath={filePath}
                grouped={groupFiles}
                toggles={folderToggles}
                onOpen={openFile}
                onFileMenu={(event, path) =>
                  openMenu(event, [
                    { label: 'Show diff', run: () => openFile(path) },
                    { label: 'View full file', run: () => setFullFile(path) },
                    {
                      label: 'Add file to agent comments',
                      run: () => {
                        const patch = patches.find((candidate) => candidate.path === path)
                        if (patch) onAddFile(pr, patch)
                      }
                    },
                    { label: viewed.has(path) ? 'Mark as not viewed' : 'Mark as viewed', run: () => toggleViewed(path) },
                    local !== null && { label: 'Open in local worktree', run: () => window.api.openPath(`${local}/${path}`) },
                    null,
                    { label: 'Copy path', run: () => copyText(path) },
                    { label: `Open files on ${providerName(pr)}`, run: () => window.open(`${pr.url}/${pr.provider === 'github' ? 'files' : 'diffs'}`) },
                    local === null && { label: `Create worktree for ${pr.sourceBranch}`, enabled: pr.state === 'open', run: () => onCreateWorktree(pr) }
                  ])
                }
                badge={(path) => {
                  const count = threads.filter((thread) => thread.path === path).length
                  return (
                    <>
                      {count > 0 && <span className="text-[11px] text-indigo-300 tabular-nums">{count}</span>}
                      {viewed.has(path) && <Icon name="check" className="size-3 shrink-0 text-emerald-400" />}
                    </>
                  )
                }}
              />
            </div>
            <ResizeHandle width={filesWidth} min={200} max={560} onResize={setFilesWidth} />
          </nav>
          {allFiles ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col select-text" onContextMenu={symbols.onContextMenu}>
              <Virtualizer className="pr-files-scroll min-h-0 flex-1 overflow-auto">
                {patches.map(renderFile)}
              </Virtualizer>
              {symbols.hoverCard}
            </div>
          ) : (
            <div className="min-h-0 min-w-0 flex-1 overflow-auto select-text" onContextMenu={symbols.onContextMenu}>
              {file && renderFile(file)}
              {symbols.hoverCard}
            </div>
          )}
        </div>
      )}
      </div>
      {commentsOpen && renderComments && (
        <aside style={{ width: commentsWidth }} className="relative flex shrink-0 flex-col border-l border-border bg-card">
          <ResizeHandle edge="left" width={commentsWidth} min={240} max={560} onResize={setCommentsWidth} />
          {renderComments(pr, (path) => {
            setView('files')
            openFile(path)
          })}
        </aside>
      )}
      </div>
    </div>
    </CodeNavigationContext.Provider>
  )
}
