import { type DiffLineAnnotation, PatchDiff, Virtualizer } from '@pierre/diffs/react'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { LineRange } from '@treeix/shared/comments'
import type { FilePatch, Repo } from '@treeix/shared/types'
import { type ConflictResult, type MergeMethod, type PullRequest, type PullRequestComment, type PullRequestDetail, type PullRequestList, type PullRequestState, REACTIONS, type Reaction, type Reviewer, type ReviewThread, type ThreadComment } from '../shared/types'
import { allFolders, ChangedFileList, folderPaths } from '@treeix/app/ChangedFiles'
import { groupOpen } from '@treeix/app/settings'
import { api, imageResolver, prSettings } from './api'
import { CodeNavigationContext, useSymbolNavigation } from '@treeix/app/codeNavigation'
import { matchesAction } from '@treeix/shared/keymap'
import { CommandPalette } from '@treeix/app/CommandPalette'
import { cachedPullRequests, onPullRequestsUpdated, refreshPullRequests, scopeKeyOf } from './pullRequestCache'
import { ErrorBoundary } from '@treeix/app/ErrorBoundary'
import { FullFileView } from './FullFileView'
import { isMarkdownPath, MarkdownPreview, PreviewToggle, useMarkdownPreview } from '@treeix/app/MarkdownPreview'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { CommentDraft, orderRange } from '@treeix/app/Comments'
import { codeThemeOptions, diffBackground } from '@treeix/app/FileView'
import { ConflictMark, groupPullRequests, involvesYou, isPullRequestSort, localWorktreeFor, markdownBase, prefix, ProviderMark, PULL_REQUEST_SORTS, type PullRequestSort, pullRequestKey, ReviewMark, reviewSettled, sortPullRequests, STATE_STYLE, StateBadge, timeAgo, UserAvatar } from './pullRequestUtils'
import { FilterSearch, matchesFilters, parseFilters, type PullRequestFilter } from './PullRequestFilter'
import { usePullRequestKeys } from './keys'
import { LazyMarkdown as Markdown, MarkdownFoldButton, MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import { EmptyState, errorMessage, FoldAllButton, IconButton, Popup, readStored, ResizeHandle, TextPrompt, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import { type Command, focusZone, getShell, type IconName, isTyping, Kbd, type KeyHint, ListToggle, PageLayout, togglePanel, useHost, useListNav, usePanels, useZone } from '@treeix/sdk'

// ponytail: keeps the most recently loaded details, which carry every patch; raise if reopening older PRs refetches too often
const MAX_CACHED_DETAILS = 30
const detailCache = new Map<string, PullRequestDetail>()
/** Conflict checks by pull request and update, so switching back and forth doesn't fetch again */
const conflictCache = new Map<string, Promise<ConflictResult>>()

/** Which files keep an open pull request from merging, found by a local in-memory merge */
function ConflictNotice({ pr, patches, onOpen }: { pr: PullRequest; patches: FilePatch[]; onOpen: (path: string) => void }): React.JSX.Element | null {
  const key = `${pr.url}@${pr.updatedAt}`
  const [result, setResult] = useState<{ key: string; value: ConflictResult } | null>(null)
  const active = pr.conflicts && pr.state === 'open'
  useEffect(() => {
    if (!active) return
    let pending = conflictCache.get(key)
    if (!pending) {
      pending = api.conflictingFiles(pr).catch((reason: unknown) => ({ error: errorMessage(reason) }))
      conflictCache.set(key, pending)
      if (conflictCache.size > MAX_CACHED_DETAILS) conflictCache.delete(conflictCache.keys().next().value ?? '')
    }
    let live = true
    pending.then((value) => {
      // Failures (offline, old git) are tried again next time rather than remembered
      if ('error' in value) conflictCache.delete(key)
      if (live) setResult({ key, value })
    })
    return () => {
      live = false
    }
  }, [key, active])
  if (!active) return null
  const value = result?.key === key ? result.value : null
  const changed = new Set(patches.map((patch) => patch.path))
  return (
    <div className="rounded-md border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs">
      {!value ? (
        <p className="text-muted-foreground">Checking conflicts...</p>
      ) : 'error' in value ? (
        <p className="break-words text-muted-foreground select-text">{value.error}</p>
      ) : value.files.length === 0 ? (
        <p className="text-muted-foreground">Conflicts with {pr.targetBranch}, but a local merge finds none yet</p>
      ) : (
        <>
          <p className="mb-1 font-medium text-red-400">
            Conflicts with {pr.targetBranch} in {value.files.length} {value.files.length === 1 ? 'file' : 'files'}
          </p>
          {value.files.map((path) => {
            const inPatches = changed.has(path)
            return (
              <button
                key={path}
                title={inPatches ? path : `${path} (not changed by this pull request)`}
                onClick={() => inPatches && onOpen(path)}
                onContextMenu={(event) => openMenu(event, [inPatches && { label: 'Show diff', run: () => onOpen(path) }, { label: 'Copy path', run: () => copyText(path) }])}
                className={`flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left ${inPatches ? 'hover:bg-red-500/10' : 'cursor-default text-muted-foreground'}`}
              >
                <FileIcon path={path} />
                <span className="truncate">{path}</span>
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}
/** Returning to the app reloads an open pull request at most this often */
const DETAIL_FOCUS_REFRESH_MS = 30_000
/** Files changed remembers its panels apart from the conversation: the diff wants the inspector's width */
const FILES_PAGE = 'prs:files'

const LIST_HINTS: KeyHint[] = [
  ['j k', 'move'],
  ['⏎', 'open'],
  ['/', 'search'],
  ['⇧S', 'sort'],
  ['f', 'involves me']
]
const CONVERSATION_HINTS: KeyHint[] = [
  ['j k', 'threads'],
  ['[ ]', 'switch'],
  ['c', 'comment'],
  ['a', 'agent'],
  ['x', 'resolve'],
  ['r', 'review'],
  ['m', 'merge'],
  ['⇧R', 'ready']
]
const FILES_HINTS: KeyHint[] = [
  ['n p', 'file'],
  ['j k', 'threads'],
  ['v', 'viewed'],
  ['c', 'comment'],
  ['a', 'agent'],
  ['[ ]', 'switch']
]
const INSPECTOR_HINTS: KeyHint[] = [
  ['w', 'worktree'],
  ['o', 'open'],
  ['y', 'copy link']
]

/** What a pull request's detail needs from the host, bound by the plugin entry */
export type DetailProps = {
  repos: Repo[] | null
  diffStyle: 'split' | 'unified'
  /** The send-comments-to-agent button for a pull request's checkout */
  renderSend?: (pr: PullRequest) => React.ReactNode
  /** The agent comments panel for this pull request's checkout; `openFile` jumps to a commented file */
  renderComments?: (pr: PullRequest, openFile: (path: string) => void) => React.ReactNode
  onOpenWorktree: (worktreePath: string) => void
  onAddToComments: (pr: PullRequest, thread: ReviewThread) => void
  /** Keeps a drafted note as an agent comment instead of posting it; `range` is null for the whole file */
  onAddNote: (pr: PullRequest, patch: FilePatch, range: LineRange | null, text: string) => void
  /** Adds a changed file's path to the agent comments */
  onAddFile: (pr: PullRequest, patch: FilePatch) => void
  onCreateWorktree: (pr: PullRequest) => void
}

function Segment<T extends string>({ value, options, onChange }: { value: T; options: [T, React.ReactNode][]; onChange: (value: T) => void }): React.JSX.Element {
  return (
    <div className="flex h-6 shrink-0 items-center rounded-md bg-muted p-0.5 ring-1 ring-border">
      {options.map(([option, label]) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`flex h-5 items-center gap-1 rounded px-2 text-[11px] whitespace-nowrap ${option === value ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const SECTION_LABEL = 'flex h-7 w-full shrink-0 items-center gap-1.5 px-3 text-left text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase'

/** A section heading; with `onToggle` it folds its section */
const SectionLabel = ({ children, open, onToggle }: { children: React.ReactNode; open?: boolean; onToggle?: () => void }): React.JSX.Element =>
  onToggle ? (
    <button onClick={onToggle} className={`${SECTION_LABEL} hover:text-foreground`}>
      <Icon name="chevron" className={`size-3 ${open ? 'rotate-90' : ''}`} />
      {children}
    </button>
  ) : (
    <div className={SECTION_LABEL}>{children}</div>
  )

function parseFolded(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function PullRequestsView({
  repoPaths,
  scopeLabel,
  onOpenTab,
  ...detailProps
}: DetailProps & {
  /** Repositories to query, following the sidebar folder or focus filter */
  repoPaths: string[] | null
  scopeLabel: string
  onOpenTab: (pr: PullRequest) => void
}): React.JSX.Element {
  const { repos, onOpenWorktree, onCreateWorktree } = detailProps
  const host = useHost()
  const { zone } = useZone()
  const scopeKey = repoPaths ? scopeKeyOf(repoPaths) : ''
  const [data, setData] = useState<PullRequestList | null>(() => cachedPullRequests(scopeKey))
  const [loading, setLoading] = useState(false)
  const [provider, setProvider] = usePersisted<'all' | 'github' | 'gitlab'>(workspaceKey('prs.provider'), 'all')
  const [status, setStatus] = usePersisted<PullRequestState>(workspaceKey('prs.state'), 'open')
  const [involved, setInvolved] = usePersisted<boolean>(workspaceKey('prs.involvesMe'), false)
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
  const [storedSort, setSort] = usePersisted<string>(workspaceKey('prs.sort'), 'updated')
  const sort: PullRequestSort = isPullRequestSort(storedSort) ? storedSort : 'updated'
  const [sortOpen, setSortOpen] = useState(false)

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
  const inScope = byProvider.filter((pr) => matchesFilters(pr, filters) && (!involved || involvesYou(pr)))
  const visible = sortPullRequests(inScope.filter((pr) => pr.state === status), sort)
  // Only open pull requests are grouped; merged and closed ones have nothing left to do
  const groups = status === 'open' ? groupPullRequests(visible) : [{ id: 'all', label: '', pullRequests: visible }]
  const [foldedJson, setFoldedJson] = usePersisted<string>(workspaceKey('prs.folded'), '[]')
  const folded = new Set<string>(parseFolded(foldedJson))
  const setFolded = (next: Set<string>): void => setFoldedJson(JSON.stringify([...next]))
  const toggleGroup = (id: string): void => {
    const next = new Set(folded)
    if (!next.delete(id)) next.add(id)
    setFolded(next)
  }
  const foldable = groups.filter((group) => group.label)
  const anyOpen = foldable.some((group) => !folded.has(group.id))
  const foldAll = (): void => setFolded(anyOpen ? new Set(foldable.map((group) => group.id)) : new Set())
  // Folded groups drop out of j/k, like closed folders
  const ordered = groups.flatMap((group) => (group.label && folded.has(group.id) ? [] : group.pullRequests))
  const selected = ordered.find((pr) => pullRequestKey(pr) === selectedKey) ?? ordered[0]
  const nav = useListNav({ count: ordered.length, index: selected ? ordered.indexOf(selected) : -1, onSelect: (index) => setSelectedKey(pullRequestKey(ordered[index])) })

  const focusSearch = (): void => {
    const input = (): HTMLInputElement | null => document.querySelector('[data-pr-search] input')
    if (!input()) togglePanel('list', host.activePage)
    requestAnimationFrame(() => input()?.focus())
  }
  usePullRequestKeys({
    sort: () => setSortOpen(true),
    involves: () => {
      setInvolved(!involved)
      host.flash(involved ? 'All pull requests' : 'Only pull requests that involve you')
    },
    filter: focusSearch,
    // z folds what the focused zone shows: these groups in the list, the file folders in main
    ...(foldable.length > 1 && zone === 'list' ? { fold: foldAll } : {})
  })

  const row = (pr: PullRequest, index: number): React.JSX.Element => {
    const local = localWorktreeFor(repos, pr)
    const settled = reviewSettled(pr.review) && pr !== selected
    return (
      <div
        key={pullRequestKey(pr)}
        {...nav.rowProps(index)}
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
        className={`mx-1.5 flex cursor-default flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent ${settled ? 'opacity-60' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={pr.provider} className="size-3.5" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {prefix(pr)}
            {pr.number}
          </span>
          <span title={pr.title} className={`min-w-0 flex-1 truncate text-[12.5px] ${settled ? '' : 'font-medium'}`}>
            {pr.title}
          </span>
          <span className="shrink-0 text-[10.5px] text-muted-foreground">{timeAgo(pr.updatedAt)}</span>
        </div>
        {/* Author, branch and the size of the change on one line; tags get their own line below */}
        <div className="flex min-w-0 items-center gap-1.5 pl-5.5 text-[11px] text-muted-foreground">
          <UserAvatar name={pr.author} url={pr.authorAvatarUrl} size="size-4" />
          <span title={pr.sourceBranch} className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
            {pr.sourceBranch}
          </span>
          {local && (
            <span title={`Local worktree at ${local}`} className="shrink-0 text-foreground/70">
              <Icon name="branch" className="size-3" />
            </span>
          )}
          {pr.additions !== null && <span className="shrink-0 font-mono text-[10.5px] text-emerald-400">+{pr.additions}</span>}
          {pr.deletions !== null && <span className="shrink-0 font-mono text-[10.5px] text-red-400">-{pr.deletions}</span>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1 pl-5.5 empty:hidden">
          {pr.draft && <StateBadge pr={pr} />}
          <ConflictMark pr={pr} />
          <ReviewMark review={pr.review} />
        </div>
      </div>
    )
  }

  let rowIndex = 0
  const list = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span
          title={`${repoPaths?.length ?? 0} ${repoPaths?.length === 1 ? 'repository' : 'repositories'} in ${scopeLabel}`}
          className="truncate text-[11px] font-semibold tracking-wide uppercase"
        >
          Pull requests
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{visible.length}</span>
        <span className="flex-1" />
        {foldable.length > 1 && <FoldAllButton anyOpen={anyOpen} onClick={foldAll} />}
        <IconButton label={loading ? 'Refreshing' : 'Refresh'} onClick={refresh}>
          <Icon name={loading ? 'loader' : 'refresh'} className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div data-pr-search className="flex min-w-0">
          <FilterSearch pullRequests={byProvider} filters={filters} onChange={setFilters} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segment
            value={status}
            onChange={setStatus}
            options={(['open', 'merged', 'closed'] as const).map((value) => [
              value,
              <>
                {STATE_STYLE[value].label}
                <span className="text-muted-foreground tabular-nums">{inScope.filter((pr) => pr.state === value).length}</span>
              </>
            ])}
          />
          <span className="flex-1" />
          <button
            title="Sort (⇧S)"
            onClick={() => setSortOpen(true)}
            className={`flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent hover:text-foreground ${sort === 'updated' ? 'text-muted-foreground' : 'text-foreground'}`}
          >
            <Icon name="sort" className="size-3 shrink-0" />
            <span className="truncate">{PULL_REQUEST_SORTS[sort]}</span>
            <Kbd hint>⇧S</Kbd>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segment
            value={provider}
            onChange={setProvider}
            options={(['all', 'github', 'gitlab'] as const).map((value) => [
              value,
              <>
                {value !== 'all' && <ProviderMark provider={value} className="size-3" />}
                {{ all: 'All', github: 'GitHub', gitlab: 'GitLab' }[value]}
              </>
            ])}
          />
          <button
            title="Yours, asked of you, or reviewed by you (GitHub only)"
            onClick={() => setInvolved(!involved)}
            className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] whitespace-nowrap ring-1 ${
              involved ? 'bg-foreground/10 text-foreground ring-border' : 'text-muted-foreground ring-border hover:text-foreground'
            }`}
          >
            Involves me
            <Kbd hint>f</Kbd>
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!data && <EmptyState title="Loading pull requests..." />}
        {data && data.errors.length > 0 && (
          <details className="mx-2 mt-2 rounded-md bg-red-400/10 px-2 py-1.5 text-[11px] text-red-400">
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
        {data && visible.length === 0 && <EmptyState icon="pullRequest" title={filters.length || involved ? 'No pull requests match' : 'No pull requests'} />}
        {groups.map((group) => (
          <div key={group.id}>
            {group.label && (
              <SectionLabel open={!folded.has(group.id)} onToggle={() => toggleGroup(group.id)}>
                {group.label}
                <span className="font-normal text-muted-foreground/60 tabular-nums">{group.pullRequests.length}</span>
              </SectionLabel>
            )}
            {!(group.label && folded.has(group.id)) && group.pullRequests.map((pr) => row(pr, rowIndex++))}
          </div>
        ))}
      </div>
    </>
  )

  return (
    <>
      {selected ? (
        <PullRequestDetailView pr={selected} list={list} {...detailProps} />
      ) : (
        <PageLayout
          listLabel="Pull requests"
          hints={{ list: LIST_HINTS }}
          list={list}
          main={<EmptyState fill icon="pullRequest" title={data ? 'No pull request selected' : 'Loading...'} />}
        />
      )}
      {sortOpen && (
        <Picker
          onClose={() => setSortOpen(false)}
          commands={(Object.keys(PULL_REQUEST_SORTS) as PullRequestSort[]).map((key) => ({
            id: key,
            group: 'Sort pull requests',
            label: PULL_REQUEST_SORTS[key],
            icon: key === sort ? 'check' : 'sort',
            run: () => setSort(key)
          }))}
        />
      )}
    </>
  )
}

/**
 * The palette as a picker: type to narrow, arrows and Enter to choose. Focus goes back to the zone it came from,
 * unless the choice opened something that took it, like the reason for requesting changes.
 */
function Picker({ commands, onClose, placeholder = 'Type to narrow' }: { commands: Command[]; onClose: () => void; placeholder?: string }): React.JSX.Element {
  const zone = useRef(getShell().zone)
  useEffect(() => () => void requestAnimationFrame(() => document.activeElement === document.body && focusZone(zone.current)), [])
  return <CommandPalette browseFiles placeholder={placeholder} commands={commands} onClose={onClose} />
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
  const pickerButton = useRef<HTMLButtonElement>(null)
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
          className={`flex h-6 items-center gap-1 rounded-full px-2 text-xs ring-1 ${added.includes(reaction) ? 'bg-foreground/10 ring-border' : 'ring-border hover:bg-accent'}`}
        >
          {REACTION_EMOJI[reaction]} <span className="text-muted-foreground tabular-nums">{count(reaction)}</span>
        </button>
      ))}
      <button
        ref={pickerButton}
        title={`React on ${providerName(pr)}`}
        onClick={() => setPickerOpen(!pickerOpen)}
        className="grid size-6 place-items-center rounded-full text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground"
      >
        <Icon name="smilePlus" className="size-3.5" />
      </button>
      {pickerOpen && (
        <Popup
          anchor={pickerButton}
          onDismiss={() => setPickerOpen(false)}
          onMouseLeave={() => setPickerOpen(false)}
          className="flex flex-wrap gap-0.5 rounded-lg border border-input bg-popover p-1"
        >
          {REACTIONS.map((reaction) => (
            <button key={reaction} onClick={() => react(reaction)} className="grid size-7 place-items-center rounded-md text-base hover:bg-accent">
              {REACTION_EMOJI[reaction]}
            </button>
          ))}
        </Popup>
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
      className="group/branch flex max-w-full min-w-0 items-center gap-1.5 rounded bg-foreground/[.06] px-1.5 font-mono text-[11px] text-foreground/80 hover:bg-foreground/10"
    >
      <span className="truncate">{branch}</span>
      <Icon name={copied ? 'check' : 'copy'} className={`size-3 shrink-0 ${copied ? 'text-emerald-400' : 'text-muted-foreground group-hover/branch:text-foreground'}`} />
    </button>
  )
}

const REVIEWER_LOOK: Record<Reviewer['state'], { label: string; className: string }> = {
  requested: { label: 'Pending', className: 'text-amber-400' },
  approved: { label: 'Approved', className: 'text-emerald-400' },
  changes: { label: 'Changes', className: 'text-red-400' },
  commented: { label: 'Commented', className: 'text-muted-foreground' }
}

/** A reviewer's state as a small badge on their avatar; pending is a plain dot */
function ReviewerMark({ state }: { state: Reviewer['state'] }): React.JSX.Element {
  return (
    <span className={`absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-background ${REVIEWER_LOOK[state].className}`}>
      {state === 'requested' ? <span className="size-1.5 rounded-full bg-current" /> : <Icon name={state === 'approved' ? 'check' : state === 'changes' ? 'alert' : 'comment'} className="size-2" />}
    </span>
  )
}

/** A reviewer with their state; anyone who already reviewed can be asked to look again */
function ReviewerRow({ reviewer, pr, onRequested, onError }: { reviewer: Reviewer; pr: PullRequest; onRequested: () => Promise<void>; onError: (message: string) => void }): React.JSX.Element {
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
    <div className="flex h-7 min-w-0 items-center gap-2 px-3 text-xs">
      <UserAvatar name={reviewer.login} url={reviewer.avatarUrl} size="size-4" />
      <span title={reviewer.login} className="min-w-0 flex-1 truncate">
        {reviewer.login}
      </span>
      <span className={`shrink-0 text-[11px] ${look.className}`}>{look.label}</span>
      {state !== 'requested' && (
        <button
          onClick={request}
          title={`Ask ${reviewer.login} to review again`}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="refresh" className="size-3" />
        </button>
      )}
    </div>
  )
}

function ActionRow({ icon, label, keys, onClick }: { icon: IconName; label: string; keys: string; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-foreground/85 hover:bg-accent">
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Kbd hint>{keys}</Kbd>
    </button>
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

function ThreadButton({ onClick, disabled = false, keys, children }: { onClick: () => void; disabled?: boolean; keys: string | null; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] whitespace-nowrap text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground disabled:opacity-60"
    >
      {children}
      {keys && <Kbd hint>{keys}</Kbd>}
    </button>
  )
}

type Editing = { id: string; body: string }

function ThreadCard({
  thread,
  pr,
  withPath,
  cursor,
  added,
  replying,
  editing,
  viewer,
  pending,
  onOpenPath,
  onAdd,
  onReply,
  onCloseReply,
  onSendReply,
  onResolve,
  onRetry,
  onDiscard,
  onEdit,
  onSaveEdit,
  onDelete
}: {
  thread: ReviewThread
  pr: PullRequest
  /** In the conversation the card names its file and line, which jump to the diff */
  withPath: boolean
  /** Spread from the main zone's cursor; the card under it shows its keys */
  cursor: { 'data-cursor'?: '' }
  added: boolean
  replying: boolean
  editing: Editing | null
  /** Your login; your own comments can be edited and deleted */
  viewer: string | null
  pending: PendingComment[]
  onOpenPath: () => void
  onAdd: () => void
  onReply: () => void
  onCloseReply: () => void
  onSendReply: (body: string) => Promise<void>
  onResolve: (resolved: boolean) => void
  onRetry: (comment: PendingComment) => void
  onDiscard: (comment: PendingComment) => void
  onEdit: (editing: Editing | null) => void
  onSaveEdit: (comment: ThreadComment, body: string) => void
  onDelete: (comment: ThreadComment) => void
}): React.JSX.Element {
  const keys = (key: string): string | null => (cursor['data-cursor'] === '' ? key : null)
  const showHeader = (withPath && thread.path) || thread.resolved === true || (withPath && thread.resolved === false)
  return (
    <div {...cursor} className={`rounded-md border border-border font-sans text-[13px] text-foreground ${cursor['data-cursor'] === '' ? 'bg-foreground/[.04]' : 'bg-card'} ${thread.resolved ? 'opacity-70' : ''}`}>
      {showHeader && (
        <div className="flex h-7 min-w-0 items-center gap-2 border-b border-border px-3 text-[11px] text-muted-foreground">
          {withPath && thread.path && (
            <button title={`Show ${thread.path} in files changed`} onClick={onOpenPath} className="flex min-w-0 items-center gap-1.5 font-mono hover:text-foreground">
              <Icon name="file" className="size-3 shrink-0" />
              <span className="truncate">
                {thread.path}
                {thread.line !== null && `:${thread.line}`}
              </span>
            </button>
          )}
          <span className="flex-1" />
          {thread.resolved === true && <span className="shrink-0 text-emerald-400">Resolved</span>}
          {withPath && thread.resolved === false && <span className="shrink-0 text-amber-400">Unresolved</span>}
        </div>
      )}
      {thread.comments.map((comment) => {
        const mine = viewer !== null && comment.author === viewer
        const remove = (): void => onDelete(comment)
        return (
          <div
            key={comment.id}
            className="flex gap-2.5 border-b border-border px-3 py-2.5"
            onContextMenu={(event) =>
              openMenu(event, [
                { label: 'Copy comment', run: () => copyText(comment.body) },
                mine && { label: 'Edit comment', run: () => onEdit({ id: comment.id, body: comment.body }) },
                mine && { label: 'Delete comment', run: remove },
                { label: `Copy @${comment.author}`, run: () => copyText(`@${comment.author}`) },
                null,
                { label: added ? 'Added to agent comments' : 'Add thread to agent comments', enabled: !added, run: onAdd },
                { label: `Reply on ${providerName(pr)}`, run: onReply },
                { label: `Open on ${providerName(pr)}`, run: () => window.open(pr.url) }
              ])
            }
          >
            <UserAvatar name={comment.author} url={comment.avatarUrl} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="truncate font-semibold">{comment.author}</span>
                <span className="shrink-0 text-muted-foreground">{timeAgo(comment.createdAt)} ago</span>
                <span className="flex-1" />
                {mine && editing?.id !== comment.id && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <IconButton label="Edit comment (e)" onClick={() => onEdit({ id: comment.id, body: comment.body })}>
                      <Icon name="pencil" className="size-3" />
                    </IconButton>
                    <IconButton label="Delete comment (d)" onClick={remove}>
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
                    onChange={(event) => onEdit({ id: comment.id, body: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') onEdit(null)
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && editing.body.trim()) onSaveEdit(comment, editing.body.trim())
                    }}
                    rows={Math.min(12, Math.max(3, editing.body.split('\n').length + 1))}
                    className="w-full resize-y rounded-md bg-muted px-2 py-1.5 text-[13px] leading-5 ring-1 ring-border outline-none"
                  />
                  <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
                    <span className="mr-auto text-[11px] text-muted-foreground">⌘↵ to save, esc to cancel</span>
                    <button onClick={() => onEdit(null)} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                      Cancel
                    </button>
                    <button
                      disabled={!editing.body.trim() || editing.body.trim() === comment.body}
                      onClick={() => onSaveEdit(comment, editing.body.trim())}
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
        <PendingCommentView key={comment.id} comment={comment} onRetry={() => onRetry(comment)} onDiscard={() => onDiscard(comment)} />
      ))}
      {replying && (
        <div className="border-b border-border p-2">
          <CommentDraft
            label={`Reply on ${providerName(pr)}`}
            placeholder="Write a reply"
            submitLabel={`Reply on ${providerName(pr)}`}
            allowAttachments={false}
            onCancel={onCloseReply}
            onSave={(body) => onSendReply(body).then(onCloseReply)}
          />
        </div>
      )}
      {/* Narrow panes wrap whole buttons onto a new line instead of breaking their labels */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        {!replying && (
          <ThreadButton onClick={onReply} keys={keys('c')}>
            <ProviderMark provider={pr.provider} className="size-3" />
            Reply
          </ThreadButton>
        )}
        <ThreadButton onClick={onAdd} disabled={added} keys={added ? null : keys('a')}>
          <Icon name={added ? 'check' : 'comment'} className="size-3" />
          {added ? 'Added to agent comments' : 'Add to agent comments'}
        </ThreadButton>
        {thread.resolved !== null && (
          <ThreadButton onClick={() => onResolve(!thread.resolved)} keys={keys('x')}>
            <Icon name="check" className="size-3" />
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </ThreadButton>
        )}
      </div>
    </div>
  )
}

const MERGE_METHODS: Record<MergeMethod, { label: string; detail: string }> = {
  squash: { label: 'Squash and merge', detail: 'All changes in one commit' },
  merge: { label: 'Merge commit', detail: 'All commits plus a merge commit' },
  rebase: { label: 'Rebase and merge', detail: 'Commits replayed, no merge commit' }
}
const isMergeMethod = (value: string): value is MergeMethod => Object.hasOwn(MERGE_METHODS, value)

type Place = { view: 'conversation' | 'files'; filePath: string | null }

/**
 * useState that starts over when `scope` changes, so the detail follows the list's selection without remounting the
 * list beside it. Setters from an earlier scope, like a slow load of the pull request selected before, are ignored.
 */
function useScopedState<T>(scope: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState({ scope, value: initial })
  const set = useCallback(
    (action: React.SetStateAction<T>) =>
      setState((current) => (current.scope === scope ? { scope, value: typeof action === 'function' ? (action as (previous: T) => T)(current.value) : action } : current)),
    [scope]
  )
  if (state.scope === scope) return [state.value, set]
  setState({ scope, value: initial })
  return [initial, set]
}

export function PullRequestDetailView({
  pr,
  list,
  repos,
  diffStyle,
  renderSend,
  renderComments,
  onOpenWorktree,
  onAddToComments,
  onAddNote,
  onAddFile,
  onCreateWorktree
}: DetailProps & {
  pr: PullRequest
  /** The pull request list, when it sits beside this view */
  list?: React.ReactNode
}): React.JSX.Element {
  const host = useHost()
  const { zone } = useZone()
  const [detail, setDetail] = useScopedState<PullRequestDetail | null>(pr.url, null)
  const [error, setError] = useScopedState<string | null>(pr.url, null)
  // Each pull request reopens on the tab and file it was left on
  const placeKey = `prs.place:${pr.url}`
  const savedPlace = ((): Place => {
    const stored = readStored(placeKey)
    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
    return { view: record.view === 'files' ? 'files' : 'conversation', filePath: typeof record.filePath === 'string' ? record.filePath : null }
  })()
  const [view, setView] = useScopedState<Place['view']>(pr.url, savedPlace.view)
  const [filePath, setFilePath] = useScopedState<string | null>(pr.url, savedPlace.filePath)
  useEffect(() => localStorage.setItem(placeKey, JSON.stringify({ view, filePath })), [view, filePath])
  const pageId = view === 'files' ? FILES_PAGE : host.activePage
  const panels = usePanels(pageId)
  /** The file a comment draft belongs to; in the all-files scroll every file can take one */
  const [draftPath, setDraftPath] = useScopedState<string | null>(pr.url, null)
  /** Last file under the pointer, which symbol navigation resolves against in the all-files scroll */
  const [pointerPath, setPointerPath] = useScopedState<string | null>(pr.url, null)
  const [viewed, setViewed] = useScopedState<Set<string>>(pr.url, new Set())
  const [picker, setPicker] = useScopedState<'files' | 'review' | 'merge' | null>(pr.url, null)
  const [fullFile, setFullFile] = useScopedState<string | null>(pr.url, null)
  const [addedFiles, setAddedFiles] = useScopedState<Set<string>>(pr.url, new Set())
  const [addedThreads, setAddedThreads] = useScopedState<Set<string>>(pr.url, new Set())
  /** The file with an open whole-file comment draft */
  const [fileCommentPath, setFileCommentPath] = useScopedState<string | null>(pr.url, null)
  const { prFilesView } = prSettings.use()
  const allFiles = prFilesView === 'all'
  const [draft, setDraft] = useScopedState<LineRange | null>(pr.url, null)
  const [composing, setComposing] = useScopedState(pr.url, false)
  const [replyTo, setReplyTo] = useScopedState<string | null>(pr.url, null)
  const [editing, setEditing] = useScopedState<Editing | null>(pr.url, null)
  const [groupFiles, setGroupFiles] = usePersisted<boolean>(workspaceKey('prs.groupFiles'), true)
  const folderToggles = useScopedState<Set<string>>(pr.url, new Set())
  const [toggledFolders, setToggledFolders] = folderToggles
  const [filesWidth, setFilesWidth] = usePersisted<number>('prs.filesWidth', 300)
  const [markdownPreview, setMarkdownPreview] = useMarkdownPreview()
  const local = localWorktreeFor(repos, pr)
  const agentComments = host.comments.filter((comment) => comment.worktreePath === (local ?? pr.repoPath)).length
  // A worktree on the PR branch matches the diff line for line; otherwise the repo checkout can only be searched by name
  const outerNavigation = useContext(CodeNavigationContext)
  const navigation = outerNavigation && { ...outerNavigation, worktreePath: local ?? pr.repoPath, exact: local !== null }
  const noNavigation = (): void => undefined
  /** Composers and editors that close hand the keys back to the main zone, where the next verb is */
  const backToMain = (): void => focusZone('main')

  const load = (): Promise<void> =>
    api.pullRequestDetail(pr).then((result) => {
      detailCache.delete(pr.url)
      detailCache.set(pr.url, result)
      if (detailCache.size > MAX_CACHED_DETAILS) detailCache.delete(detailCache.keys().next().value ?? '')
      setDetail(result)
      setFilePath((current) => current ?? result.patches[0]?.path ?? null)
    })

  // New commits or comments bump updatedAt in the background list refresh; coming back to the app checks again
  const loadedFor = useRef(pr.updatedAt)
  const restoredScroll = useRef(false)
  useEffect(() => {
    loadedFor.current = pr.updatedAt
    restoredScroll.current = false
    const cachedDetail = detailCache.get(pr.url)
    setDetail(cachedDetail ?? null)
    setFilePath(savedPlace.filePath ?? cachedDetail?.patches[0]?.path ?? null)
    setError(null)
    load().catch((reason: unknown) => cachedDetail === undefined && setError(errorMessage(reason)))
  }, [pr.url])

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
  const anyFolderOpen = folders.some((folder) => groupOpen(toggledFolders, folder))
  const foldFolders = (): void => setToggledFolders(allFolders(folders, !anyFolderOpen))
  const canFoldFolders = view === 'files' && groupFiles && folders.length > 1
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
  const [resolvedNow, setResolvedNow] = useScopedState<Record<string, boolean>>(pr.url, {})
  const [pending, setPending] = useScopedState<PendingComment[]>(pr.url, [])
  useEffect(() => setResolvedNow({}), [detail])
  /** Edits and deletes of your own comments, shown before the provider confirms them */
  const [commentChanges, setCommentChanges] = useScopedState<Record<string, string | null>>(pr.url, {})
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
  const saveEdit = (comment: ThreadComment, body: string): void => {
    changeComment(comment, body)
    setEditing(null)
    backToMain()
  }
  const deleteComment = (comment: ThreadComment): void => {
    if (window.confirm(`Delete this comment on ${providerName(pr)}?`)) changeComment(comment, null)
  }
  const resolvedCount = allThreads.filter((thread) => thread.resolved).length
  const unresolvedCount = allThreads.filter((thread) => thread.resolved === false).length
  // Resolved conversations are done; they stay out of the way unless asked for
  const threads = showResolved ? allThreads : allThreads.filter((thread) => !thread.resolved)
  const file = patches.find((patch) => patch.path === filePath)
  const symbols = useSymbolNavigation({
    worktreePath: local ?? pr.repoPath,
    path: (allFiles ? pointerPath : null) ?? file?.path ?? '',
    exact: local !== null,
    onNavigate: navigation?.onNavigate ?? noNavigation
  })
  const showView = (next: Place['view']): void => {
    setView(next)
    focusZone('main')
  }
  const showConflictFile = (path: string): void => {
    setView('files')
    openFile(path)
  }
  const openThread = (thread: ReviewThread): void => {
    if (!thread.path) return
    setFilePath(thread.path)
    setView('files')
  }
  const addThread = (thread: ReviewThread): void => {
    onAddToComments(pr, thread)
    setAddedThreads(new Set(addedThreads).add(thread.id))
  }
  const addFile = (patch: FilePatch): void => {
    onAddFile(pr, patch)
    setAddedFiles(new Set(addedFiles).add(patch.path))
  }
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

  // The main zone's cursor walks the threads on screen: the conversation's, or the open file's in line order
  const cursorThreads = view === 'files' ? threads.filter((thread) => thread.path === filePath).sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) : threads
  const [cursor, setCursor] = useScopedState(pr.url, -1)
  useEffect(() => setCursor(-1), [view, filePath])
  const cursorIndex = Math.min(cursor, cursorThreads.length - 1)
  const threadNav = useListNav({
    zone: 'main',
    count: cursorThreads.length,
    index: cursorIndex,
    onSelect: setCursor,
    onOpen: (index) => {
      const thread = cursorThreads[index]
      if (view === 'conversation' && thread.path) openThread(thread)
      else setReplyTo(thread.id)
    }
  })
  const threadAtCursor = (): ReviewThread | undefined => (getShell().zone === 'main' ? cursorThreads[cursorIndex] : undefined)
  const ownCommentAtCursor = (): ThreadComment | undefined => {
    const viewer = detail?.viewer
    return viewer ? threadAtCursor()?.comments.findLast((comment) => comment.author === viewer) : undefined
  }

  const threadCard = (thread: ReviewThread, withPath: boolean): React.JSX.Element => {
    const index = cursorThreads.indexOf(thread)
    return (
      <ThreadCard
        thread={thread}
        pr={pr}
        withPath={withPath}
        cursor={index < 0 ? {} : threadNav.rowProps(index)}
        added={addedThreads.has(thread.id)}
        replying={replyTo === thread.id}
        editing={editing}
        viewer={detail?.viewer ?? null}
        pending={pending.filter((comment) => comment.threadId === thread.id)}
        onOpenPath={() => openThread(thread)}
        onAdd={() => addThread(thread)}
        onReply={() => setReplyTo(thread.id)}
        onCloseReply={() => {
          setReplyTo(null)
          backToMain()
        }}
        onSendReply={(body) => sendNew(body, thread.id)}
        onResolve={(resolved) => resolve(thread, resolved)}
        onRetry={send}
        onDiscard={discard}
        onEdit={(next) => {
          setEditing(next)
          if (!next) backToMain()
        }}
        onSaveEdit={saveEdit}
        onDelete={deleteComment}
      />
    )
  }

  // In the all-files scroll, go back to the file this pull request was left on once its diff has loaded
  useEffect(() => {
    if (!detail || restoredScroll.current || !allFiles || view !== 'files' || !savedPlace.filePath) return
    restoredScroll.current = true
    openFile(savedPlace.filePath)
  }, [detail, view])

  // Goes to a changed file, like VS Code's quick open
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!matchesAction(event, 'prs.findFile') || !detail) return
      event.preventDefault()
      setView('files')
      setPicker('files')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  const readPullRequestFile = (path: string): Promise<string | null> => (local ? window.api.readFile(local, path) : api.pullRequestFile(pr, path))

  // Reviews show as sent straight away and go back if the provider refuses; the reason dialog keeps its text on failure
  const [sentReview, setSentReview] = useScopedState<PullRequestDetail['myReview']>(pr.url, null)
  const [reason, setReason] = useScopedState<string | null>(pr.url, null)
  const myReview = sentReview ?? detail?.myReview ?? null
  const approve = (): void => {
    setSentReview('approved')
    api.submitReview(pr, 'approve', '').then(load, (failure: unknown) => {
      setSentReview(null)
      setError(`Approval not sent: ${errorMessage(failure)}`)
    })
  }
  const requestChanges = (body: string): Promise<void> => {
    setSentReview('changes')
    api.submitReview(pr, 'changes', body).then(load, (failure: unknown) => {
      setSentReview(null)
      setReason(body)
      setError(`Change request not sent: ${errorMessage(failure)}`)
    })
    return Promise.resolve()
  }

  // GitHub refuses reviews of your own pull request; the list knows it's yours before the detail has loaded
  const own = detail?.viewer ? detail.viewer === pr.author : pr.review?.state === 'yours'
  // Draft flips show straight away and go back if the provider refuses
  const [draftNow, setDraftNow] = useScopedState<boolean | null>(pr.url, null)
  useEffect(() => setDraftNow(null), [pr.draft])
  const isDraft = draftNow ?? pr.draft
  const setDraftState = (draft: boolean): void => {
    setDraftNow(draft)
    api.setDraft(pr, draft).then(
      () => void refreshPullRequests(host.scopeRepoPaths ?? [pr.repoPath]).catch(() => undefined),
      (failure: unknown) => {
        setDraftNow(null)
        setError(`${draft ? 'Not converted to draft' : 'Not marked ready for review'}: ${errorMessage(failure)}`)
      }
    )
  }
  const showReviewers = (): void => {
    if (!panels.inspector) panels.toggle('inspector')
    focusZone('inspector')
  }

  // Merging can't be undone, so it waits for the provider instead of showing the result early; the method used last comes first
  const [storedMethod, setMethod] = usePersisted<string>('prs.mergeMethod', 'squash')
  const method: MergeMethod = isMergeMethod(storedMethod) ? storedMethod : 'squash'
  const [deleteBranch, setDeleteBranch] = usePersisted<boolean>('prs.deleteBranchOnMerge', true)
  const [merging, setMerging] = useScopedState(pr.url, false)
  /** The method picked, waiting for a second, deliberate confirm */
  const [confirmMerge, setConfirmMerge] = useScopedState<MergeMethod | null>(pr.url, null)
  const mergeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => void (confirmMerge && requestAnimationFrame(() => mergeButton.current?.focus())), [confirmMerge])
  const mergeBlocked = merging ? 'Merging…' : pr.conflicts ? 'Resolve the conflicts first' : isDraft ? 'Drafts can’t be merged' : null
  const cancelMerge = (): void => {
    setConfirmMerge(null)
    backToMain()
  }
  const merge = (chosen: MergeMethod): void => {
    if (merging) return
    setMethod(chosen)
    setMerging(true)
    api
      .merge(pr, chosen, deleteBranch)
      .then(
        () => {
          host.flash(`Merged ${prefix(pr)}${pr.number} into ${pr.targetBranch}`)
          void load().catch(() => undefined)
          // The list moves it to Merged
          void refreshPullRequests(host.scopeRepoPaths ?? [pr.repoPath]).catch(() => undefined)
        },
        (failure: unknown) => setError(`Not merged: ${errorMessage(failure)}`)
      )
      .finally(() => {
        setMerging(false)
        setConfirmMerge(null)
        // Only when focus went down with the confirm button, not if you moved on while it merged
        if (document.activeElement === document.body || document.activeElement === mergeButton.current) backToMain()
      })
  }

  // Esc that closes a draft or the merge confirmation keeps focus in main instead of the shell taking it to the list
  const draftOpen = draft !== null || composing || replyTo !== null || fileCommentPath !== null || editing !== null
  useEffect(() => {
    if (!draftOpen && !confirmMerge) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') event.preventDefault()
      if (!confirmMerge || isTyping(event)) return
      if (event.key === 'Escape') cancelMerge()
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        merge(confirmMerge)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [draftOpen, confirmMerge, deleteBranch, merging])

  const pickerCommands = (): Command[] => {
    const title = `${prefix(pr)}${pr.number}`
    if (picker === 'files') {
      return patches.map((patch) => ({ id: patch.path, group: 'Files', label: baseName(patch.path), detail: patch.path, filePath: patch.path, run: () => openFile(patch.path) }))
    }
    if (picker === 'review') {
      return [
        { id: 'approve', group: `Review ${title}`, label: myReview === 'approved' ? 'Approved' : 'Approve', detail: 'Marks the changes as good to merge', icon: 'check', run: () => myReview !== 'approved' && approve() },
        { id: 'changes', group: `Review ${title}`, label: 'Request changes', detail: 'Asks for a reason and blocks the merge', icon: 'alert', run: () => setReason('') }
      ]
    }
    const group = `Merge ${title} into ${pr.targetBranch}`
    const methods = [method, ...(Object.keys(MERGE_METHODS) as MergeMethod[]).filter((candidate) => candidate !== method)]
    return [
      ...methods.map((candidate): Command => ({
        id: candidate,
        group,
        label: MERGE_METHODS[candidate].label,
        detail: `${MERGE_METHODS[candidate].detail}, asks to confirm`,
        icon: 'pullRequest',
        run: () => setConfirmMerge(candidate)
      }))
    ]
  }

  const worktree = (): void => {
    if (local) onOpenWorktree(local)
    else if (pr.state === 'open') onCreateWorktree(pr)
    else host.flash(`${prefix(pr)}${pr.number} is ${pr.state}, its branch may be gone`)
  }
  const openInBrowser = (): void => void window.open(pr.url)
  const copyLink = (): void => {
    copyText(pr.url)
    host.flash('Link copied')
  }
  const comment = (): void => {
    const thread = threadAtCursor()
    if (thread) return setReplyTo(thread.id)
    if (view === 'files' && file) return setFileCommentPath(file.path)
    setView('conversation')
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-new-comment] textarea')?.focus())
  }
  const stepFile = (step: 1 | -1): void => {
    const next = patches[Math.max(0, Math.min(patches.length - 1, patches.findIndex((patch) => patch.path === filePath) + step))]
    if (next) openFile(next.path)
  }
  const onOwnComment = (run: (comment: ThreadComment) => void) => (): void => {
    const own = ownCommentAtCursor()
    if (own) run(own)
    else host.flash('Move the cursor to a thread with your comment (j k in the main zone)')
  }
  usePullRequestKeys({
    conversation: () => showView('conversation'),
    files: () => showView('files'),
    comment,
    agent: () => {
      const thread = threadAtCursor()
      if (thread) return addedThreads.has(thread.id) ? host.flash('Already added') : addThread(thread)
      if (view === 'files' && file) return addedFiles.has(file.path) ? host.flash('Already added') : addFile(file)
      host.flash('Move the cursor to a thread first (j k in the main zone)')
    },
    edit: onOwnComment((own) => setEditing({ id: own.id, body: own.body })),
    delete: onOwnComment(deleteComment),
    resolve: () => {
      const thread = threadAtCursor()
      if (thread && thread.resolved !== null) resolve(thread, !thread.resolved)
    },
    ...(view === 'files' && {
      nextFile: () => stepFile(1),
      previousFile: () => stepFile(-1),
      viewed: () => file && toggleViewed(file.path)
    }),
    ...(pr.state === 'open' && {
      ...(!own && { review: () => setPicker('review') }),
      merge: () => (mergeBlocked ? host.flash(mergeBlocked) : setPicker('merge')),
      // Anyone with write access can mark a draft ready; only your own go back to draft
      ...((isDraft || own) && { ready: () => setDraftState(!isDraft) })
    }),
    ...(canFoldFolders && zone === 'main' && { fold: foldFolders }),
    worktree,
    open: openInBrowser,
    copy: copyLink
  })

  const renderFile = (patch: FilePatch): React.JSX.Element => {
    const isViewed = viewed.has(patch.path)
    // Like GitHub, viewed files fold away in the scroll; in single-file view the open file always shows
    const collapsed = allFiles && isViewed
    const preview = markdownPreview && isMarkdownPath(patch.path)
    const fileThreads = threads.filter((thread) => thread.path === patch.path && thread.line !== null)
    const fileDraft = draftPath === patch.path ? draft : null
    const current = patch.path === filePath
    const annotations: DiffLineAnnotation<{ threadId: string | null }>[] = [
      ...fileThreads.map((thread) => ({ side: thread.side, lineNumber: thread.line ?? 0, metadata: { threadId: thread.id } })),
      ...(fileDraft ? [{ side: fileDraft.endSide ?? fileDraft.side ?? ('additions' as const), lineNumber: fileDraft.end, metadata: { threadId: null } }] : [])
    ]
    const startDraft = (range: LineRange): void => {
      setDraftPath(patch.path)
      setDraft(orderRange(range))
    }
    const closeDraft = (): void => {
      setDraft(null)
      backToMain()
    }
    const closeFileComment = (): void => {
      setFileCommentPath(null)
      backToMain()
    }
    return (
      <MarkdownFoldScope key={patch.path}>
        <section data-file-path={patch.path} onPointerEnter={() => setPointerPath(patch.path)} className={allFiles ? 'border-b border-border' : ''}>
          <div className="sticky top-0 z-10 flex h-9 min-w-0 items-center gap-2 border-b border-border bg-background pr-2 pl-4 font-mono text-xs text-foreground/85">
            <span title={patch.path} className="min-w-0 shrink truncate">
              {patch.path}
            </span>
            <span className="shrink-0 font-sans text-[11px] tabular-nums">
              <span className="text-emerald-400">+{patch.additions}</span> <span className="text-red-400">-{patch.deletions}</span>
            </span>
            {/* The hint gives way first, so the Viewed toggle stays visible in narrow panes */}
            <span className="ml-auto min-w-0 shrink-[2] truncate font-sans text-[11px] text-muted-foreground">{!collapsed && preview ? `Rendered from ${pr.sourceBranch}` : ''}</span>
            {isMarkdownPath(patch.path) && !collapsed && <PreviewToggle on={markdownPreview} onChange={setMarkdownPreview} />}
            <button
              onClick={() => setFileCommentPath(fileCommentPath === patch.path ? null : patch.path)}
              title={`Comment on the whole file on ${providerName(pr)} (c)`}
              className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground ${fileCommentPath === patch.path ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              <Icon name="plus" className="size-3.5" />
            </button>
            <button
              onClick={() => addFile(patch)}
              title={addedFiles.has(patch.path) ? 'Added to agent comments' : 'Add this file path to agent comments (a)'}
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
              <Icon name="check" className="size-3" />
              Viewed
              {current && <Kbd hint>v</Kbd>}
            </button>
          </div>
          {fileCommentPath === patch.path && (
            <div className="p-3">
              <CommentDraft
                label={`Comment on ${baseName(patch.path)} · posts to ${providerName(pr)}`}
                placeholder="Write a comment about the whole file"
                submitLabel={`Comment on ${providerName(pr)}`}
                allowAttachments={false}
                onCancel={closeFileComment}
                alternative={{
                  label: 'Add to agent comments',
                  onSave: (text) => {
                    onAddNote(pr, patch, null, text)
                    closeFileComment()
                  }
                }}
                onSave={(body) => post({ body, path: patch.path }).then(closeFileComment)}
              />
            </div>
          )}
          {/* Whole-file threads have no line to anchor to, so they sit above the diff */}
          {!collapsed &&
            threads
              .filter((thread) => thread.path === patch.path && thread.line === null)
              .map((thread) => (
                <div key={thread.id} className="mx-3 my-2">
                  {threadCard(thread, false)}
                </div>
              ))}
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
                if (thread) return <div className="mx-3 my-2">{threadCard(thread, false)}</div>
                return fileDraft ? (
                  <div className="mx-3 my-2">
                    <CommentDraft
                      label={`Comment on line ${fileDraft.end} · posts to ${providerName(pr)}`}
                      placeholder="Write a review comment"
                      submitLabel={`Comment on ${providerName(pr)}`}
                      allowAttachments={false}
                      onCancel={closeDraft}
                      alternative={{
                        label: 'Add to agent comments',
                        onSave: (text) => {
                          onAddNote(pr, patch, fileDraft, text)
                          closeDraft()
                        }
                      }}
                      onSave={(body) => post({ body, path: patch.path, line: fileDraft.end, side: fileDraft.endSide ?? fileDraft.side }).then(closeDraft)}
                    />
                  </div>
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
      </MarkdownFoldScope>
    )
  }

  const reviewLook =
    myReview === 'approved'
      ? { label: 'Approved', className: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30', icon: 'check' as const }
      : myReview === 'changes'
        ? { label: 'Changes requested', className: 'bg-red-400/12 text-red-400 ring-red-400/30', icon: 'alert' as const }
        : { label: 'Review', className: 'text-foreground ring-input hover:bg-accent', icon: 'eye' as const }

  const header = (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-9 min-w-0 items-center gap-2 border-b border-border bg-card px-1.5 text-xs text-muted-foreground">
        {list !== undefined && <ListToggle page={pageId} />}
        <ProviderMark provider={pr.provider} className="size-3.5" />
        <span title={pr.repoPath} className="min-w-0 truncate">
          {baseName(pr.repoPath)}
        </span>
        <span className="shrink-0 font-mono">
          {prefix(pr)}
          {pr.number}
        </span>
        <StateBadge pr={isDraft === pr.draft ? pr : { ...pr, draft: isDraft }} />
        <ReviewMark review={pr.review} />
        <ConflictMark pr={pr} />
        <span className="flex-1" />
        <button
          onClick={() => panels.toggle('inspector')}
          title={`${panels.inspector ? 'Hide' : 'Show'} details and ${agentComments} agent comment${agentComments === 1 ? '' : 's'} (⌘⌥B)`}
          className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent hover:text-foreground ${panels.inspector ? 'bg-foreground/10 text-foreground' : ''}`}
        >
          <Icon name="panel" className="size-4 -scale-x-100" />
          {agentComments > 0 && (
            <span className="flex items-center gap-1 text-foreground tabular-nums">
              <Icon name="comment" className="size-3" />
              {agentComments}
            </span>
          )}
          <Kbd hint>⌘⌥B</Kbd>
        </button>
      </div>
      <div className="px-5 pt-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 title={pr.title} className="line-clamp-2 min-w-48 flex-1 text-base leading-6 font-semibold break-words select-text">
            {pr.title}
          </h1>
          {pr.state === 'open' && (
            <div className="flex shrink-0 items-center gap-2">
              {isDraft && own && (
                <button onClick={() => setDraftState(false)} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground ring-1 ring-input hover:bg-accent">
                  <Icon name="check" className="size-3.5" />
                  Ready for review
                  <Kbd hint>⇧R</Kbd>
                </button>
              )}
              {!own && (
                <button onClick={() => setPicker('review')} className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ${reviewLook.className}`}>
                  <Icon name={reviewLook.icon} className="size-3.5" />
                  {reviewLook.label}
                  <Kbd hint>r</Kbd>
                </button>
              )}
              <button
                onClick={() => (mergeBlocked ? host.flash(mergeBlocked) : setPicker('merge'))}
                title={mergeBlocked ?? `Merge into ${pr.targetBranch}`}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${mergeBlocked ? 'text-muted-foreground ring-1 ring-border' : 'bg-primary text-white hover:bg-primary/90'}`}
              >
                <Icon name={merging ? 'loader' : 'pullRequest'} className="size-3.5" />
                {merging ? 'Merging…' : 'Merge'}
                <Kbd hint>m</Kbd>
              </button>
            </div>
          )}
        </div>
        {confirmMerge && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-foreground/5 p-1.5">
            <button
              ref={mergeButton}
              onClick={() => merge(confirmMerge)}
              // A held Enter from the picker must not repeat into this button
              onKeyDown={(event) => event.key === 'Enter' && event.repeat && event.preventDefault()}
              disabled={merging}
              className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-white hover:bg-primary/90 focus-visible:bg-primary/80 disabled:opacity-60"
            >
              <Icon name={merging ? 'loader' : 'pullRequest'} className="size-3.5 shrink-0" />
              <span className="truncate">{merging ? 'Merging…' : `${MERGE_METHODS[confirmMerge].label} into ${pr.targetBranch}`}</span>
              <Kbd hint>⌘↵</Kbd>
            </button>
            <label title={`Deletes ${pr.sourceBranch} after merging`} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} className="shrink-0" />
              <span className="truncate">Delete {pr.sourceBranch}</span>
            </label>
            <span className="flex-1" />
            <button onClick={cancelMerge} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent">
              Cancel
              <Kbd hint>esc</Kbd>
            </button>
          </div>
        )}
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <UserAvatar name={pr.author} url={pr.authorAvatarUrl} size="size-4" />
          <span className="max-w-full truncate text-foreground/85">{pr.author}</span>
          <BranchCopy branch={pr.sourceBranch} />
          <span>into</span>
          <BranchCopy branch={pr.targetBranch} />
          {pr.additions !== null && <span className="font-mono text-emerald-400">+{pr.additions}</span>}
          {pr.deletions !== null && <span className="font-mono text-red-400">-{pr.deletions}</span>}
          <span className="whitespace-nowrap">updated {timeAgo(pr.updatedAt)} ago</span>
          {detail && detail.reviewers.length > 0 && (
            <button onClick={showReviewers} className="flex shrink-0 items-center gap-1.5 rounded px-1 hover:bg-accent hover:text-foreground">
              reviewers
              {detail.reviewers.map((reviewer) => (
                <span key={reviewer.login} className="relative">
                  <UserAvatar name={reviewer.login} url={reviewer.avatarUrl} size="size-4" title={`${reviewer.login}: ${REVIEWER_LOOK[reviewer.state].label}`} />
                  <ReviewerMark state={reviewer.state} />
                </span>
              ))}
            </button>
          )}
        </div>
        <div className="my-2 flex flex-wrap items-center gap-2">
          <Segment
            value={view}
            onChange={showView}
            options={[
              [
                'conversation',
                <>
                  Conversation
                  <span className="tabular-nums text-muted-foreground">{threads.reduce((sum, thread) => sum + thread.comments.length, 0)}</span>
                </>
              ],
              [
                'files',
                <>
                  Files changed
                  <span className="tabular-nums text-muted-foreground">{patches.length}</span>
                </>
              ]
            ]}
          />
          <Kbd hint>[</Kbd>
          <Kbd hint>]</Kbd>
          <span className="flex-1" />
          {unresolvedCount > 0 && <span className="text-[11px] whitespace-nowrap text-amber-400">{unresolvedCount} unresolved</span>}
          {resolvedCount > 0 && (
            <button onClick={() => setShowResolved(!showResolved)} className="text-[11px] whitespace-nowrap text-muted-foreground hover:text-foreground">
              {showResolved ? `Hide ${resolvedCount} resolved` : `Show ${resolvedCount} resolved`}
            </button>
          )}
          {view === 'conversation' && <MarkdownFoldButton />}
        </div>
      </div>
    </div>
  )

  const conversation = detail && (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2 px-5 py-4">
        <ConflictNotice pr={pr} patches={patches} onOpen={showConflictFile} />
        {/* The description reads as the page itself: the author is already in the header above */}
        <div className="mb-2 [&_.markdown>:first-child]:mt-0">
          {detail.body ? (
            <Markdown baseUrl={markdownBase(pr)} resolveImage={imageResolver(pr)}>
              {detail.body}
            </Markdown>
          ) : (
            <p className="text-[13px] text-muted-foreground">No description</p>
          )}
        </div>
        <LinkPreviews urls={detail.body.match(/https?:\/\/[^\s)<>\]"']+/g) ?? []} />
        {threads.map((thread) => (
          <div key={thread.id}>{threadCard(thread, true)}</div>
        ))}
        {pending.some((entry) => entry.threadId === null) && (
          <div className="overflow-hidden rounded-md border border-border bg-card">
            {pending
              .filter((entry) => entry.threadId === null)
              .map((entry) => (
                <PendingCommentView key={entry.id} comment={entry} onRetry={() => send(entry)} onDiscard={() => discard(entry)} />
              ))}
          </div>
        )}
        {/* Always open, like GitHub; composing tracks whether it holds focus so page keys and Esc leave it alone */}
        <div data-new-comment className="[&>div]:m-0" onFocus={() => setComposing(true)} onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setComposing(false)}>
          <CommentDraft
            key={pr.url}
            persistent
            label={`New comment on ${providerName(pr)}`}
            placeholder="Write a comment"
            submitLabel={`Comment on ${providerName(pr)}`}
            allowAttachments={false}
            onCancel={backToMain}
            onSave={(body) => sendNew(body, null).then(backToMain)}
          />
        </div>
      </div>
    </div>
  )

  const files = detail && (
    <div className="flex min-h-0 flex-1">
      <nav style={{ width: filesWidth }} className="relative flex shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-[11px] text-muted-foreground">
          <span className="truncate font-medium" title={`Click a line number in a diff to comment on ${providerName(pr)}`}>
            {patches.length} files
          </span>
          <Kbd hint>n</Kbd>
          <Kbd hint>p</Kbd>
          <span className="flex-1" />
          {canFoldFolders && <FoldAllButton anyOpen={anyFolderOpen} groups="folders" onClick={foldFolders} />}
          <IconButton label={groupFiles ? 'Show as flat list' : 'Group by folder'} active={groupFiles} onClick={() => setGroupFiles(!groupFiles)}>
            <Icon name={groupFiles ? 'folder' : 'list'} className="size-3.5" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="mb-2 empty:hidden">
            <ConflictNotice pr={pr} patches={patches} onOpen={openFile} />
          </div>
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
                    if (patch) addFile(patch)
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
                  {count > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>}
                  {viewed.has(path) && <Icon name="check" className="size-3 shrink-0 text-emerald-400" />}
                </>
              )
            }}
          />
        </div>
        <ResizeHandle width={filesWidth} min={180} max={560} onResize={setFilesWidth} />
      </nav>
      {allFiles ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col select-text" onContextMenu={symbols.onContextMenu}>
          <Virtualizer className="pr-files-scroll min-h-0 flex-1 overflow-auto">{patches.map(renderFile)}</Virtualizer>
          {symbols.hoverCard}
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto select-text" onContextMenu={symbols.onContextMenu}>
          {file && renderFile(file)}
          {symbols.hoverCard}
        </div>
      )}
    </div>
  )

  const main = (
    <CodeNavigationContext.Provider value={navigation}>
      <MarkdownFoldScope>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The inspector has the comments panel with its own send button; without it the pill sends */}
          {renderSend && !(panels.inspector && renderComments) && <div className="absolute right-4 bottom-4 z-30">{renderSend(pr)}</div>}
          {header}
          {error && (
            <p className="mx-5 mt-3 flex items-start gap-2 rounded-md bg-red-400/10 px-3 py-2 text-xs break-words text-red-400 select-text">
              <span className="min-w-0 flex-1">{error}</span>
              <button onClick={() => setError(null)} title="Dismiss" className="shrink-0 text-red-400/70 hover:text-red-400">
                <Icon name="close" className="size-3" />
              </button>
            </p>
          )}
          {!detail && !error && <EmptyState fill title="Loading..." />}
          <ErrorBoundary label={view === 'files' ? 'Files changed' : 'Conversation'} resetKey={`${pr.url}:${view}`}>
            {view === 'files' ? files : conversation}
          </ErrorBoundary>
        </div>
      </MarkdownFoldScope>
    </CodeNavigationContext.Provider>
  )

  const inspector = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="flex-1 truncate text-[11px] font-semibold tracking-wide uppercase">Details</span>
        <IconButton label="Hide inspector (⌘⌥B)" onClick={() => panels.toggle('inspector')}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </div>
      <div className="max-h-[60%] shrink-0 overflow-y-auto pb-2">
        <SectionLabel>Reviewers</SectionLabel>
        {(detail?.reviewers ?? []).map((reviewer) => (
          <ReviewerRow key={reviewer.login} reviewer={reviewer} pr={pr} onRequested={load} onError={setError} />
        ))}
        {detail && detail.reviewers.length === 0 && <p className="px-3 text-xs text-muted-foreground">No reviewers</p>}
        <SectionLabel>Actions</SectionLabel>
        <div className="px-1.5">
          <ActionRow icon="branch" label={local ? 'Open worktree' : `Create worktree for ${pr.sourceBranch}`} keys="w" onClick={worktree} />
          <ActionRow icon="comment" label={`Comment on ${providerName(pr)}`} keys="c" onClick={comment} />
          <ActionRow icon="external" label={`Open on ${providerName(pr)}`} keys="o" onClick={openInBrowser} />
          <ActionRow icon="copy" label="Copy link" keys="y" onClick={copyLink} />
          {pr.state === 'open' && own && <ActionRow icon={isDraft ? 'check' : 'pencil'} label={isDraft ? 'Mark ready for review' : 'Convert to draft'} keys="⇧R" onClick={() => setDraftState(!isDraft)} />}
        </div>
      </div>
      {renderComments && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          {renderComments(pr, (path) => {
            setView('files')
            openFile(path)
          })}
        </div>
      )}
    </div>
  )

  return (
    <>
      <PageLayout
        id={pageId}
        defaults={view === 'files' ? { inspector: false } : undefined}
        listLabel="Pull requests"
        inspectorLabel="Details"
        hints={{ list: LIST_HINTS, main: view === 'files' ? FILES_HINTS : CONVERSATION_HINTS, inspector: INSPECTOR_HINTS }}
        list={list}
        main={
          <ErrorBoundary label={`${prefix(pr)}${pr.number}`} resetKey={pr.url}>
            {main}
          </ErrorBoundary>
        }
        inspector={
          <ErrorBoundary label="Details" resetKey={pr.url}>
            {inspector}
          </ErrorBoundary>
        }
      />
      {picker && (
        <Picker
          placeholder={picker === 'files' ? 'Go to file: type or paste a path' : undefined}
          onClose={() => setPicker(null)}
          commands={pickerCommands()}
        />
      )}
      {reason !== null && (
        <TextPrompt
          title="Request changes"
          description={`Tells ${pr.author} what has to change before this can merge.`}
          placeholder="What needs to change"
          confirmLabel="Request changes"
          initialValue={reason}
          onSubmit={requestChanges}
          onClose={() => {
            setReason(null)
            backToMain()
          }}
        />
      )}
      {fullFile && <FullFileView path={fullFile} subtitle={`at ${pr.sourceBranch}`} load={() => readPullRequestFile(fullFile)} onClose={() => setFullFile(null)} />}
    </>
  )
}
