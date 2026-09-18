import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import { CopyButton, EmptyState, errorMessage, IconButton, ResizeHandle, UserAvatar, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import type { WorkItem, WorkItemDetail, WorkItemList } from '../shared/types'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { type FilterGroup, FilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { detailCache, jiraApi, jiraSettings, LIST_LIMIT, listCache, ME, meCache, resolveImage, scopedJql, selection, TTL } from './api'
import { StatusPill, TypeMark } from './marks'
import { type Bucket, BUCKETS, bucketOf, byPriority, projectOf } from './buckets'

/** Branch names for a work item, e.g. OPN-412-rate-limit-behind-proxy */
export const branchFor = (item: WorkItem): string =>
  `${item.key}-${item.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')}`

/** Writes a comment on the work item; Jira takes it as plain text */
function CommentBox({ itemKey, onPosted }: { itemKey: string; onPosted: () => void }): React.JSX.Element {
  const host = useHost()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const send = (): void => {
    if (!body.trim() || sending) return
    setSending(true)
    jiraApi.comment(itemKey, body.trim()).then(
      () => {
        setBody('')
        host.flash(`Commented on ${itemKey}`)
        onPosted()
      },
      (reason: unknown) => host.flash(errorMessage(reason))
    ).finally(() => setSending(false))
  }
  return (
    <div className="rounded-xl border border-border px-3 py-2.5">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && send()}
        placeholder={`Comment on ${itemKey}`}
        rows={body ? 4 : 2}
        className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="flex-1 text-[11px] text-muted-foreground">Plain text, ⌘↵ to send</span>
        <button onClick={send} disabled={!body.trim() || sending} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
          {sending ? 'Sending…' : 'Comment'}
        </button>
      </div>
    </div>
  )
}

function Detail({ item, statuses, onChanged }: { item: WorkItem; statuses: string[]; onChanged: () => void }): React.JSX.Element {
  const host = useHost()
  const { value: detail, error, refresh: reloadDetail } = useCached<WorkItemDetail>(detailCache, item.key, TTL.detail, jiraApi.detail)
  const linked = (host.repos ?? []).flatMap((repo) => repo.worktrees.filter((worktree) => worktree.branch?.includes(item.key)).map((worktree) => ({ repo, worktree })))

  const transition = (status: string): void => {
    host.flash(`Moving ${item.key} to ${status}...`)
    jiraApi.transition(item.key, status).then(
      () => {
        host.flash(`${item.key} is ${status}`)
        reloadDetail()
        onChanged()
      },
      (reason: unknown) => host.flash(errorMessage(reason))
    )
  }

  const openWorktree = (event: React.MouseEvent): void => {
    const create = (repoPath: string): void => {
      host.flash(`Creating worktree for ${item.key}...`)
      host.createWorktree(repoPath, branchFor(item), undefined, host.service('sessions') ? 'claude' : null).catch((reason: unknown) => host.flash(errorMessage(reason)))
    }
    const repos = host.scopeRepoPaths ?? []
    if (repos.length === 1) return create(repos[0])
    openMenu(event, repos.map((path) => ({ label: `In ${baseName(path)}`, run: () => create(path) })))
  }

  const addToComments = (): void => {
    const worktreePath = linked[0]?.worktree.path ?? host.selectedWorktree
    if (!worktreePath) return host.flash('Select a worktree first')
    host.addComment({
      id: crypto.randomUUID(),
      worktreePath,
      filePath: `${item.key} ${item.summary}`,
      range: { start: 0, end: 0 },
      code: '',
      text: `Jira ${item.key}${item.url ? ` (${item.url})` : ''}: ${item.summary}\n\n${detail?.description ?? ''}`.trim()
    })
    host.flash(`Added ${item.key} to comments on ${baseName(worktreePath)}`)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <TypeMark type={item.type} />
        <span className="font-mono">{item.key}</span>
        <CopyButton label="Copy key" text={() => item.key} />
        <span>· {item.type} · {detail?.project ?? item.project}</span>
        <span className="flex-1" />
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer" className="flex h-7 items-center gap-1.5 rounded-md px-2.5 ring-1 ring-input hover:bg-accent">
            Open in Jira <Icon name="external" className="size-3" />
          </a>
        )}
      </div>
      <h1 className="mt-1.5 text-[17px] font-semibold select-text">{item.summary}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={(event) => openMenu(event, statuses.filter((status) => status !== item.status).map((status) => ({ label: `Move to ${status}`, run: () => transition(status) })))}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-input hover:bg-accent"
        >
          <StatusPill item={item} />
          <Icon name="chevron" className="size-3 rotate-90" />
        </button>
        <button onClick={openWorktree} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
          Open worktree
        </button>
        <button onClick={addToComments} className="h-7 rounded-md px-3 text-xs ring-1 ring-input hover:bg-accent">
          Add to agent comments
        </button>
        <span className="flex-1" />
        {detail?.updatedAt && <span className="text-[11px] text-muted-foreground">Updated {timeAgo(detail.updatedAt)} ago</span>}
      </div>
      <dl className="mt-4 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[12.5px]">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="flex items-center gap-2">
          {item.assignee && <UserAvatar name={item.assignee} url={item.assigneeAvatar} size="size-5" />}
          {item.assignee ?? 'Unassigned'}
        </dd>
        <dt className="text-muted-foreground">Reporter</dt>
        <dd className="flex items-center gap-2">
          {detail?.reporter && <UserAvatar name={detail.reporter} url={detail.reporterAvatar} size="size-5" />}
          {detail?.reporter ?? '-'}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{item.priority ?? '-'}</dd>
        {detail && detail.labels.length > 0 && (
          <>
            <dt className="text-muted-foreground">Labels</dt>
            <dd className="flex flex-wrap gap-1">
              {detail.labels.map((label) => (
                <span key={label} className="rounded bg-foreground/8 px-1.5 text-[11px] text-muted-foreground">
                  {label}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      <section className="mt-4 rounded-xl border border-border p-4">
        <h3 className="mb-2 text-[13px] font-medium">Description</h3>
        {error && <p className="text-xs text-red-400 select-text">{error}</p>}
        {!detail && !error && <p className="text-xs text-muted-foreground">Loading...</p>}
        {detail &&
          (detail.description ? (
            <Markdown resolveImage={resolveImage}>{detail.description}</Markdown>
          ) : (
            <p className="text-xs text-muted-foreground">No description</p>
          ))}
      </section>
      {detail && <LinkPreviews urls={detail.links} exclude={[item.key]} />}
      {detail && (
        <section className="mt-4">
          <h3 className="mb-2 text-[13px] font-medium">Comments {detail.comments.length || ''}</h3>
          {detail.comments.map((comment, index) => (
            <div key={`${comment.created}:${index}`} className="mb-3 rounded-xl border border-border px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs">
                <UserAvatar name={comment.author} url={comment.authorAvatar} size="size-5" />
                <span className="font-medium">{comment.author}</span>
                <span className="text-muted-foreground">· {timeAgo(comment.created)} ago</span>
              </div>
              <Markdown resolveImage={resolveImage}>{comment.body}</Markdown>
            </div>
          ))}
          <CommentBox itemKey={item.key} onPosted={reloadDetail} />
        </section>
      )}
      {linked.length > 0 && (
        <section className="mt-4 rounded-xl border border-border">
          <h3 className="border-b border-border px-4 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Worktrees</h3>
          {linked.map(({ repo, worktree }) => (
            <button key={worktree.path} onClick={() => host.openWorktree(worktree.path)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px] hover:bg-accent">
              <Icon name="branch" className="size-3.5 text-emerald-400" />
              <span className="font-mono">{worktree.branch}</span>
              <span className="text-muted-foreground">{baseName(repo.path)}</span>
              <span className="flex-1" />
              {worktree.changedFiles > 0 && <span className="text-[11px] text-muted-foreground">{worktree.changedFiles} changed</span>}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}

const UNASSIGNED = 'Unassigned'
const assigneeOf = (item: WorkItem): string => item.assignee ?? UNASSIGNED

/** Filter groups for the list box: people, projects, statuses, plus free text */
function filterGroups(myName: string | null): FilterGroup<WorkItem>[] {
  return [
    {
      kind: 'assignee',
      label: 'People',
      valueOf: assigneeOf,
      labelOf: (value) => (value === ME ? 'Me' : value),
      mark: (value, sample) => <UserAvatar name={value === ME ? (myName ?? 'Me') : value} url={sample?.assigneeAvatar ?? null} size="size-4" />
    },
    { kind: 'project', label: 'Projects', valueOf: projectOf, mark: () => <Icon name="folder" className="size-3.5 text-muted-foreground" /> },
    { kind: 'status', label: 'Statuses', valueOf: (item) => item.status, mark: () => <Icon name="list" className="size-3.5 text-muted-foreground" /> },
    { kind: 'text', label: 'Text', valueOf: () => null, freeText: (item, needle) => `${item.key} ${item.summary} ${item.status}`.toLowerCase().includes(needle) }
  ]
}

const FILTER_KINDS = ['assignee', 'project', 'status', 'text']
/** Your own items to start with; removing the chip shows everyone's */
const DEFAULT_FILTERS: FilterToken[] = [{ kind: 'assignee', value: ME }]

export function JiraTasks(): React.JSX.Element {
  const { jql, statusBuckets } = jiraSettings.use()
  const { value: myName } = useCached<string | null>(meCache, 'me', TTL.me, jiraApi.me)
  const [filtersJson, setFiltersJson] = usePersisted<string>(workspaceKey('jira.filters'), JSON.stringify(DEFAULT_FILTERS))
  const filters = parseTokens(readJson(filtersJson), FILTER_KINDS)
  const assignees = filters.filter((filter) => filter.kind === 'assignee').map((filter) => filter.value)
  // Only your own items need the narrower query; any other person means fetching everyone's and filtering here
  const mine = assignees.length > 0 && assignees.every((value) => value === ME)
  const projects = filters.filter((filter) => filter.kind === 'project').map((filter) => filter.value)
  const { value: list, loading, error, refresh } = useCached<WorkItemList>(listCache, scopedJql(jql, { mine, projects }), TTL.list, jiraApi.search)
  const [selectedKey, setSelectedKey] = usePersisted<string>(workspaceKey('jira.selected'), '')
  const [listWidth, setListWidth] = usePersisted<number>('jira.listWidth', 380)
  const [collapsedJson, setCollapsedJson] = usePersisted<string>(workspaceKey('jira.collapsed'), '["waiting","blocked","later","done"]')
  const collapsed = parseList(collapsedJson)

  const requested = selection.use().key
  useEffect(() => {
    if (!requested) return
    setSelectedKey(requested)
    selection.update({ key: null })
  }, [requested])

  const items = list?.items ?? []
  const groupsForFilter = filterGroups(myName ?? null)
  // Me stands for your display name once it is known; while it isn't, the narrower query already did the filtering
  const resolved = filters.map((filter) => (filter.kind === 'assignee' && filter.value === ME ? { ...filter, value: myName ?? ME } : filter))
  const visible = items.filter((item) => matchesTokens(item, mine && !myName ? resolved.filter((filter) => filter.kind !== 'assignee') : resolved, groupsForFilter))
  const inSprint = (item: WorkItem): boolean | null => (list?.sprintKeys ? list.sprintKeys.includes(item.key) : null)
  const groups = (Object.keys(BUCKETS) as Bucket[])
    .map((bucket) => ({ bucket, items: byPriority(visible.filter((item) => bucketOf(item, inSprint(item), statusBuckets) === bucket)) }))
    .filter((group) => group.items.length > 0)
  const selected = visible.find((item) => item.key === selectedKey) ?? groups[0]?.items[0]
  const statuses = [...new Set(items.map((item) => item.status))]
  const showAssignee = !mine

  const toggleBucket = (bucket: Bucket): void =>
    setCollapsedJson(JSON.stringify(collapsed.includes(bucket) ? collapsed.filter((entry) => entry !== bucket) : [...collapsed, bucket]))
  const moveStatus = (status: string, bucket: Bucket | null): void => {
    const { [status]: _previous, ...rest } = statusBuckets
    jiraSettings.update({ statusBuckets: bucket ? { ...rest, [status]: bucket } : rest })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside style={{ width: listWidth }} className="relative flex shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-start gap-1.5 p-2.5 pb-2">
          <FilterSearch
            items={items}
            groups={groupsForFilter}
            tokens={filters}
            onChange={(next) => setFiltersJson(JSON.stringify(next))}
            placeholder="Filter by person, project, status or text"
          />
          <IconButton label="Refresh" onClick={refresh}>
            <Icon name="refresh" className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {error && <p className="px-2 py-3 text-xs break-words text-amber-400 select-text">{error}</p>}
          {!list && !error && <EmptyState title="Loading work items..." />}
          {list && visible.length === 0 && <EmptyState title="No work items" />}
          {items.length >= LIST_LIMIT && (
            <p className="px-2 pt-3 text-[11px] text-muted-foreground">Jira returned the first {LIST_LIMIT} items. Filter by project or person to see the rest.</p>
          )}
          {groups.map(({ bucket, items: groupItems }) => {
            const open = !collapsed.includes(bucket)
            return (
              <div key={bucket}>
                <button onClick={() => toggleBucket(bucket)} className="flex w-full items-center gap-1.5 px-2 pt-3 pb-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
                  <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                  {BUCKETS[bucket]} <span className="font-normal">{groupItems.length}</span>
                </button>
                {open &&
                  groupItems.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setSelectedKey(item.key)}
                      onContextMenu={(event) =>
                        openMenu(event, [
                          { label: 'Copy key', run: () => copyText(item.key) },
                          { label: 'Copy branch name', run: () => copyText(branchFor(item)) },
                          item.url !== null && { label: 'Copy link', run: () => copyText(item.url ?? '') },
                          null,
                          ...(Object.keys(BUCKETS) as Bucket[])
                            .filter((target) => target !== bucket)
                            .map((target) => ({ label: `Show "${item.status}" in ${BUCKETS[target]}`, run: () => moveStatus(item.status, target) })),
                          statusBuckets[item.status] !== undefined && { label: `Reset "${item.status}"`, run: () => moveStatus(item.status, null) }
                        ])
                      }
                      className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left ${item.key === selected?.key ? 'bg-foreground/8 ring-1 ring-border' : 'hover:bg-accent'}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <TypeMark type={item.type} />
                        <span className="truncate text-[13px] font-medium">{item.summary}</span>
                      </span>
                      <span className="flex items-center gap-1.5 pl-[23px] text-[11.5px] whitespace-nowrap text-muted-foreground">
                        <span className="font-mono">{item.key}</span>
                        {showAssignee && <span className="truncate">· {assigneeOf(item)}</span>}
                        <span className="flex-1" />
                        {item.priority && !/normal|medium/i.test(item.priority) && <span>{item.priority}</span>}
                        <StatusPill item={item} />
                      </span>
                    </button>
                  ))}
              </div>
            )
          })}
        </div>
        <ResizeHandle width={listWidth} min={280} max={560} onResize={setListWidth} />
      </aside>
      {selected ? <Detail key={selected.key} item={selected} statuses={statuses} onChanged={refresh} /> : <EmptyState fill icon="list" title="Select a work item" />}
    </div>
  )
}

function readJson(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}
