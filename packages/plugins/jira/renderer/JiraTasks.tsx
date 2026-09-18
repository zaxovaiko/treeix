import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import { CopyButton, EmptyState, errorMessage, IconButton, ResizeHandle, UserAvatar, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import type { Epic, JiraPerson, WorkItem, WorkItemDetail, WorkItemList } from '../shared/types'
import { Picker } from './Picker'
import { applyPatch, type Patches, pendingPatches } from './optimistic'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { type FilterGroup, FilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { detailCache, epicCache, jiraApi, jiraSettings, LIST_LIMIT, listCache, ME, meCache, orderedJql, resolveImage, scopedJql, selection, summaryCache, TTL } from './api'
import { EpicChip, EpicProgress, isBug, StatusPill, TypeMark } from './marks'
import { type Bucket, BUCKETS, bucketOf, epicIndex, groupByEpic, isItemSort, projectOf, SORTS, sortItems } from './buckets'

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

type StatusOption = { name: string; category: WorkItem['statusCategory'] }
const CATEGORY_LABELS: Record<WorkItem['statusCategory'], string> = { new: 'To do', indeterminate: 'In progress', done: 'Done' }

/** Moves an item to another status, grouped by Jira's status category */
function StatusPicker({ item, statuses, onPick }: { item: WorkItem; statuses: StatusOption[]; onPick: (status: string) => void }): React.JSX.Element {
  const order = Object.keys(CATEGORY_LABELS) as WorkItem['statusCategory'][]
  return (
    <Picker
      trigger={(open) => (
        <span className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-input hover:bg-accent">
          <StatusPill item={item} />
          <Icon name="chevron" className={`size-3 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
        </span>
      )}
      options={[...statuses]
        .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
        .map((status) => ({
          id: status.name,
          label: status.name,
          section: CATEGORY_LABELS[status.category],
          render: <StatusPill item={{ ...item, status: status.name, statusCategory: status.category }} />
        }))}
      current={item.status}
      placeholder="Move to…"
      onPick={onPick}
    />
  )
}

const UNASSIGN = '-'
const MYSELF = '@me'

/** Assigns the item: yourself, nobody, people seen in the list, and whoever Jira finds for what is typed */
function AssigneePicker({ item, people, onPick }: { item: WorkItem; people: JiraPerson[]; onPick: (accountId: string | null) => void }): React.JSX.Element {
  const [found, setFound] = useState<JiraPerson[]>([])
  const everyone = [...new Map([...people, ...found].map((person) => [person.accountId, person])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const person = (name: string, avatar: string | null): React.ReactNode => (
    <>
      <UserAvatar name={name} url={avatar} size="size-5" />
      <span className="truncate">{name}</span>
    </>
  )
  return (
    <Picker
      trigger={() => (
        <span className="-mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-accent">
          {item.assignee && <UserAvatar name={item.assignee} url={item.assigneeAvatar} size="size-5" />}
          {item.assignee ?? 'Unassigned'}
          <Icon name="chevron" className="size-3 rotate-90 text-muted-foreground" />
        </span>
      )}
      options={[
        { id: MYSELF, label: 'Assign to me', section: '', render: <span className="font-medium">Assign to me</span> },
        { id: UNASSIGN, label: 'Unassigned', section: '', render: <span className="text-muted-foreground">Unassigned</span> },
        ...everyone.map((candidate) => ({ id: candidate.accountId, label: candidate.name, section: 'People', render: person(candidate.name, candidate.avatar) }))
      ]}
      current={item.assigneeId ?? (item.assignee ? null : UNASSIGN)}
      placeholder="Search people…"
      onQuery={(query) => jiraApi.assignable(item.key, query).then(setFound, () => setFound([]))}
      onPick={(id) => onPick(id === UNASSIGN ? null : id)}
    />
  )
}

/** The title, edited in place: Enter saves, Escape puts it back */
function EditableSummary({ summary, onSave }: { summary: string; onSave: (summary: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <h1 onClick={() => setDraft(summary)} title="Click to edit" className="-mx-1.5 mt-1.5 cursor-text rounded-md px-1.5 text-[17px] font-semibold hover:bg-accent">
        {summary}
      </h1>
    )
  }
  const save = (): void => {
    if (draft.trim() && draft.trim() !== summary) onSave(draft.trim())
    setDraft(null)
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') save()
        if (event.key === 'Escape') setDraft(null)
      }}
      className="-mx-1.5 mt-1.5 w-full rounded-md bg-muted px-1.5 text-[17px] font-semibold ring-1 ring-primary/60 outline-none"
    />
  )
}

/** Labels with a remove button each and a field to add one */
function LabelEditor({ labels, onAdd, onRemove }: { labels: string[]; onAdd: (label: string) => void; onRemove: (label: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <dd className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <span key={label} className="flex items-center gap-1 rounded bg-foreground/8 pr-0.5 pl-1.5 text-[11px] text-muted-foreground">
          {label}
          <button title={`Remove ${label}`} onClick={() => onRemove(label)} className="grid size-3.5 place-items-center rounded hover:text-foreground">
            <Icon name="close" className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/[\s,]/g, ''))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft) {
            onAdd(draft)
            setDraft('')
          }
        }}
        placeholder="Add label"
        className="h-5 w-24 rounded bg-transparent px-1 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:bg-muted"
      />
    </dd>
  )
}

function Detail({
  item,
  statuses,
  types,
  people,
  myName,
  onPatch,
  onChanged
}: {
  item: WorkItem
  statuses: StatusOption[]
  types: string[]
  people: JiraPerson[]
  myName: string | null
  /** Shows fields as changed right away; the returned function takes the change back */
  onPatch: (fields: Partial<WorkItem>) => () => void
  onChanged: () => void
}): React.JSX.Element {
  const host = useHost()
  const { value: detail, error, refresh: reloadDetail } = useCached<WorkItemDetail>(detailCache, item.key, TTL.detail, jiraApi.detail)
  const linked = (host.repos ?? []).flatMap((repo) => repo.worktrees.filter((worktree) => worktree.branch?.includes(item.key)).map((worktree) => ({ repo, worktree })))

  const transition = (status: string): void =>
    change(`Couldn't move ${item.key} to ${status}`, () => jiraApi.transition(item.key, status), {
      status,
      statusCategory: statuses.find((option) => option.name === status)?.category ?? item.statusCategory
    })

  const [failure, setFailure] = useState<string | null>(null)
  /** Labels as last changed here, until the item reloads with Jira's own */
  const [labels, setLabels] = useState<string[] | null>(null)
  useEffect(() => setLabels(null), [detail])
  /**
   * Every edit shows its result at once and runs in the background. If Jira refuses, the change is taken back
   * and the reason stays on screen until dismissed.
   */
  const change = (failed: string, work: () => Promise<void>, fields: Partial<WorkItem> = {}, undoLocal?: () => void): void => {
    const undo = onPatch(fields)
    setFailure(null)
    work().then(
      () => {
        reloadDetail()
        onChanged()
      },
      (reason: unknown) => {
        undo()
        undoLocal?.()
        setFailure(`${failed}: ${errorMessage(reason)}`)
      }
    )
  }
  const assign = (accountId: string | null): void => {
    const person = accountId === MYSELF ? { name: myName, avatar: null } : people.find((candidate) => candidate.accountId === accountId)
    change(`Couldn't assign ${item.key}`, () => jiraApi.assign(item.key, accountId), {
      assignee: accountId ? (person?.name ?? item.assignee) : null,
      assigneeAvatar: accountId ? (person?.avatar ?? null) : null,
      assigneeId: accountId === MYSELF ? null : accountId
    })
  }
  const shownLabels = labels ?? detail?.labels ?? []
  const changeLabels = (next: string[], failed: string, work: () => Promise<void>): void => {
    const before = labels
    setLabels(next)
    change(failed, work, {}, () => setLabels(before))
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
    const filePath = `${item.key} ${item.summary}`
    if (host.comments.some((comment) => comment.worktreePath === worktreePath && comment.filePath === filePath)) {
      return host.flash(`${item.key} is already in the comments on ${baseName(worktreePath)}`)
    }
    host.addComment({
      id: crypto.randomUUID(),
      worktreePath,
      filePath,
      range: { start: 0, end: 0 },
      code: '',
      // Only the reference: the agent reads the ticket itself, so the prompt stays short and up to date
      text: `Jira ${item.key}${item.url ? ` ${item.url}` : ''}`,
      kind: 'reference'
    })
    host.flash(`Added ${item.key} to comments on ${baseName(worktreePath)}`)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <TypeMark type={item.type} />
        <span className="font-mono">{item.key}</span>
        <CopyButton label="Copy key" text={() => item.key} />
        <span>·</span>
        <Picker
          trigger={() => <span className="-mx-1 rounded px-1 hover:bg-accent hover:text-foreground">{item.type}</span>}
          options={types.map((type) => ({ id: type, label: type, section: '', render: <><TypeMark type={type} /> {type}</> }))}
          current={item.type}
          placeholder="Change type…"
          width="w-48"
          onPick={(type) => change(`Couldn't change ${item.key} to ${type}`, () => jiraApi.edit(item.key, { type }), { type })}
        />
        <span>· {detail?.project ?? item.project}</span>
        <span className="flex-1" />
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer" className="flex h-7 items-center gap-1.5 rounded-md px-2.5 ring-1 ring-input hover:bg-accent">
            Open in Jira <Icon name="external" className="size-3" />
          </a>
        )}
      </div>
      <EditableSummary summary={item.summary} onSave={(summary) => change(`Couldn't rename ${item.key}`, () => jiraApi.edit(item.key, { summary }), { summary })} />
      {failure && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-400">
          <Icon name="alert" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words select-text">{failure}</span>
          <button title="Dismiss" onClick={() => setFailure(null)} className="grid size-4 shrink-0 place-items-center rounded hover:text-red-300">
            <Icon name="close" className="size-3" />
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPicker item={item} statuses={statuses} onPick={transition} />
        <button onClick={openWorktree} className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white">
          <Icon name="branch" className="size-3.5" />
          Open worktree
        </button>
        <button onClick={addToComments} className="flex h-7 items-center gap-1.5 rounded-md px-3 text-xs ring-1 ring-input hover:bg-accent">
          <Icon name="comment" className="size-3.5" />
          Add to agent comments
        </button>
        <span className="flex-1" />
        {detail?.updatedAt && <span className="text-[11px] text-muted-foreground">Updated {timeAgo(detail.updatedAt)} ago</span>}
      </div>
      <dl className="mt-4 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[12.5px]">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="flex items-center">
          <AssigneePicker item={item} people={people} onPick={assign} />
        </dd>
        <dt className="text-muted-foreground">Reporter</dt>
        <dd className="flex items-center gap-2">
          {detail?.reporter && <UserAvatar name={detail.reporter} url={detail.reporterAvatar} size="size-5" />}
          {detail?.reporter ?? '-'}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{item.priority ?? '-'}</dd>
        {detail?.parent && (
          <>
            <dt className="text-muted-foreground">{/epic/i.test(detail.parent.type) ? 'Epic' : 'Parent'}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <TypeMark type={detail.parent.type} />
              <button onClick={() => selection.update({ key: detail.parent?.key ?? null })} className="min-w-0 truncate text-left hover:underline">
                {detail.parent.summary}
              </button>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{detail.parent.key}</span>
            </dd>
          </>
        )}
        {detail && (
          <>
            <dt className="text-muted-foreground">Labels</dt>
            <LabelEditor
              labels={shownLabels}
              onAdd={(label) => changeLabels([...shownLabels.filter((entry) => entry !== label), label], `Couldn't add ${label}`, () => jiraApi.edit(item.key, { addLabels: [label] }))}
              onRemove={(label) => changeLabels(shownLabels.filter((entry) => entry !== label), `Couldn't remove ${label}`, () => jiraApi.edit(item.key, { removeLabels: [label] }))}
            />
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

/** Filter groups for the list box: people, types, epics, projects, statuses, plus free text */
function filterGroups(myName: string | null, epicOf: Map<string, Epic>): FilterGroup<WorkItem>[] {
  return [
    {
      kind: 'assignee',
      label: 'People',
      valueOf: assigneeOf,
      labelOf: (value) => (value === ME ? 'Me' : value),
      mark: (value, sample) => <UserAvatar name={value === ME ? (myName ?? 'Me') : value} url={sample?.assigneeAvatar ?? null} size="size-4" />
    },
    { kind: 'type', label: 'Types', valueOf: (item) => item.type, mark: (value) => <TypeMark type={value} /> },
    { kind: 'epic', label: 'Epics', valueOf: (item) => epicOf.get(item.key)?.summary ?? null, mark: () => <TypeMark type="Epic" /> },
    { kind: 'project', label: 'Projects', valueOf: projectOf, mark: () => <Icon name="folder" className="size-3.5 text-muted-foreground" /> },
    { kind: 'status', label: 'Statuses', valueOf: (item) => item.status, mark: () => <Icon name="list" className="size-3.5 text-muted-foreground" /> },
    { kind: 'text', label: 'Text', valueOf: () => null, freeText: (item, needle) => `${item.key} ${item.summary} ${item.status}`.toLowerCase().includes(needle) }
  ]
}

const FILTER_KINDS = ['assignee', 'type', 'epic', 'project', 'status', 'text']

type GroupBy = 'status' | 'epic'

const SORT_HINTS: Record<keyof typeof SORTS, React.ReactNode> = {
  status: <span>Status <span className="text-muted-foreground">in progress first</span></span>,
  priority: <span>Priority <span className="text-muted-foreground">most urgent first</span></span>,
  updated: <span>Updated <span className="text-muted-foreground">newest first</span></span>,
  created: <span>Created <span className="text-muted-foreground">newest first</span></span>
}
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
  const texts = filters.filter((filter) => filter.kind === 'text').map((filter) => filter.value)
  const [storedSort, setSort] = usePersisted<string>(workspaceKey('jira.sort'), 'status')
  const sort = isItemSort(storedSort) ? storedSort : 'status'
  const query = scopedJql(orderedJql(jql, sort === 'updated' || sort === 'created' ? sort : null), { mine, projects, texts })
  const { value: list, loading, error, refresh } = useCached<WorkItemList>(listCache, query, TTL.list, jiraApi.search)
  const [selectedKey, setSelectedKey] = usePersisted<string>(workspaceKey('jira.selected'), '')
  const [listWidth, setListWidth] = usePersisted<number>('jira.listWidth', 380)
  const [collapsedJson, setCollapsedJson] = usePersisted<string>(workspaceKey('jira.collapsed'), '["waiting","blocked","later","done"]')
  const collapsed = parseList(collapsedJson)
  const [groupBy, setGroupBy] = usePersisted<GroupBy>(workspaceKey('jira.groupBy'), 'status')

  const requested = selection.use().key
  useEffect(() => {
    if (!requested) return
    setSelectedKey(requested)
    selection.update({ key: null })
  }, [requested])

  const [patches, setPatches] = useState<Patches>({})
  // Fresh data from Jira replaces a patch once it shows the same values
  useEffect(() => setPatches((current) => pendingPatches(list?.items ?? [], current, Date.now())), [list])
  const patch = (key: string) => (fields: Partial<WorkItem>): (() => void) => {
    if (Object.keys(fields).length === 0) return () => undefined
    const previous = patches[key]
    setPatches((current) => ({ ...current, [key]: { fields: { ...current[key]?.fields, ...fields }, at: Date.now() } }))
    return () =>
      setPatches((current) => {
        const { [key]: _dropped, ...rest } = current
        return previous ? { ...rest, [key]: previous } : rest
      })
  }
  const items = (list?.items ?? []).map((item) => applyPatch(item, patches))
  // Epics load on their own and later than the list; until then rows just have no epic chip
  const projectKeys = [...new Set(items.map(projectOf))].sort().join(',')
  const { value: epics } = useCached<Epic[]>(epicCache, projectKeys, TTL.epics, jiraApi.epics)
  const epicOf = epicIndex(epics ?? [])
  const groupsForFilter = filterGroups(myName ?? null, epicOf)
  // Me stands for your display name once it is known; while it isn't, the narrower query already did the filtering
  const resolved = filters.map((filter) => (filter.kind === 'assignee' && filter.value === ME ? { ...filter, value: myName ?? ME } : filter))
  // Text was searched by Jira, which also matches descriptions and comments, so it isn't matched again here
  const localFilters = resolved.filter((filter) => filter.kind !== 'text' && !(mine && !myName && filter.kind === 'assignee'))
  const visible = items.filter((item) => matchesTokens(item, localFilters, groupsForFilter))
  const inSprint = (item: WorkItem): boolean | null => (list?.sprintKeys ? list.sprintKeys.includes(item.key) : null)
  const groups = (Object.keys(BUCKETS) as Bucket[])
    .map((bucket) => ({ bucket, items: sortItems(visible.filter((item) => bucketOf(item, inSprint(item), statusBuckets) === bucket), sort) }))
    .filter((group) => group.items.length > 0)
  const bucketRank = (item: WorkItem): number => (Object.keys(BUCKETS) as Bucket[]).indexOf(bucketOf(item, inSprint(item), statusBuckets))
  // Inside an epic, your move comes first, as in the status view
  const epicGroups = groupBy === 'epic' && epics ? groupByEpic(sortItems(visible, sort).sort((a, b) => bucketRank(a) - bucketRank(b)), epics) : []
  // An item picked from elsewhere, like an epic from the detail pane, may not be in this list; it loads on its own
  const outsideKey = selectedKey && !visible.some((item) => item.key === selectedKey) ? selectedKey : ''
  const { value: outsideItem } = useCached<WorkItem>(summaryCache, outsideKey, TTL.summary, jiraApi.summary)
  const selected =
    visible.find((item) => item.key === selectedKey) ??
    (outsideItem && outsideItem.key === outsideKey ? applyPatch(outsideItem, patches) : undefined) ??
    (groupBy === 'epic' ? epicGroups[0]?.items[0] : groups[0]?.items[0])
  // Only statuses seen on listed items are known, with the category Jira gave them
  const people: JiraPerson[] = [
    ...new Map(items.flatMap((item) => (item.assigneeId && item.assignee ? [[item.assigneeId, { accountId: item.assigneeId, name: item.assignee, avatar: item.assigneeAvatar }] as const] : []))).values()
  ]
  const types = [...new Set(['Task', 'Story', 'Bug', ...items.map((item) => item.type)])].filter((type) => !/epic|sub.?task/i.test(type))
  const statuses: StatusOption[] = [...new Map(items.map((item) => [item.status, { name: item.status, category: item.statusCategory }])).values()]
  const showAssignee = !mine

  /** Buckets by name, epics as `epic:KEY` */
  const toggleGroup = (id: string): void => setCollapsedJson(JSON.stringify(collapsed.includes(id) ? collapsed.filter((entry) => entry !== id) : [...collapsed, id]))
  const epicGroupIds = epicGroups.map(({ epic }) => `epic:${epic?.key ?? 'none'}`)
  const anyEpicOpen = epicGroupIds.some((id) => !collapsed.includes(id))
  const toggleAllEpics = (): void => {
    const others = collapsed.filter((id) => !id.startsWith('epic:'))
    setCollapsedJson(JSON.stringify(anyEpicOpen ? [...others, ...epicGroupIds] : others))
  }
  const filterByEpic = (epic: Epic): void => setFiltersJson(JSON.stringify([...filters.filter((filter) => filter.kind !== 'epic'), { kind: 'epic', value: epic.summary }]))

  const row = (item: WorkItem): React.JSX.Element => {
    const bucket = bucketOf(item, inSprint(item), statusBuckets)
    const epic = groupBy === 'status' ? epicOf.get(item.key) : undefined
    return (
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
        <span className="flex min-w-0 items-center gap-1.5 pl-6 text-[11.5px] whitespace-nowrap text-muted-foreground">
          {isBug(item.type) && <span className="h-[18px] shrink-0 rounded bg-red-500/12 px-1.5 text-[10.5px] leading-[18px] font-medium text-red-400">{item.type}</span>}
          <span className="font-mono">{item.key}</span>
          {showAssignee && <span className="truncate">· {assigneeOf(item)}</span>}
          {epic && <EpicChip summary={epic.summary} onClick={() => filterByEpic(epic)} />}
          <span className="flex-1" />
          {item.priority && !/normal|medium/i.test(item.priority) && <span>{item.priority}</span>}
          <StatusPill item={item} />
        </span>
      </button>
    )
  }

  const groupHeader = (id: string, open: boolean, content: React.ReactNode): React.JSX.Element => (
    <button onClick={() => toggleGroup(id)} className="flex w-full min-w-0 items-center gap-1.5 px-2 pt-3 pb-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
      <Icon name="chevron" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      {content}
    </button>
  )
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
            placeholder="Search Jira, or filter by person, project, status"
            freeTextHint="Press ↵ to search Jira for this text"
          />
          <IconButton label="Refresh" onClick={refresh}>
            <Icon name="refresh" className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1 px-2.5 pb-1 text-[11px] text-muted-foreground">
          Group by
          {(['status', 'epic'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setGroupBy(mode)}
              className={`h-6 rounded-md px-2 ${groupBy === mode ? 'bg-accent font-medium text-foreground ring-1 ring-border' : 'hover:bg-accent hover:text-foreground'}`}
            >
              {mode === 'status' ? 'Whose move' : 'Epic'}
            </button>
          ))}
          <span className="flex-1" />
          <Picker
            trigger={(open) => (
              <span className="flex h-6 items-center gap-1 rounded-md px-2 hover:bg-accent hover:text-foreground">
                Sort: <span className="text-foreground">{SORTS[sort]}</span>
                <Icon name="chevron" className={`size-3 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
              </span>
            )}
            options={(Object.keys(SORTS) as (keyof typeof SORTS)[]).map((id) => ({ id, label: SORTS[id], section: '', render: SORT_HINTS[id] }))}
            current={sort}
            placeholder="Sort by…"
            width="w-56"
            onPick={setSort}
          />
          {groupBy === 'epic' && epicGroupIds.length > 1 && (
            <button onClick={toggleAllEpics} className="h-6 rounded-md px-2 hover:bg-accent hover:text-foreground">
              {anyEpicOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {error && <p className="px-2 py-3 text-xs break-words text-amber-400 select-text">{error}</p>}
          {!list && !error && <EmptyState title="Loading work items..." />}
          {list && visible.length === 0 && <EmptyState title="No work items" />}
          {items.length >= LIST_LIMIT && (
            <p className="px-2 pt-3 text-[11px] text-muted-foreground">Jira returned the first {LIST_LIMIT} items. Filter by project or person to see the rest.</p>
          )}
          {groupBy === 'status' &&
            groups.map(({ bucket, items: groupItems }) => {
              const open = !collapsed.includes(bucket)
              return (
                <div key={bucket}>
                  {groupHeader(
                    bucket,
                    open,
                    <>
                      {BUCKETS[bucket]} <span className="font-normal">{groupItems.length}</span>
                    </>
                  )}
                  {open && groupItems.map(row)}
                </div>
              )
            })}
          {groupBy === 'epic' && !epics && list && <p className="px-2 py-3 text-[11px] text-muted-foreground">Loading epics...</p>}
          {groupBy === 'epic' &&
            epicGroups.map(({ epic, items: groupItems }) => {
              const id = `epic:${epic?.key ?? 'none'}`
              const open = !collapsed.includes(id)
              return (
                <div key={id}>
                  {groupHeader(
                    id,
                    open,
                    epic ? (
                      <>
                        <TypeMark type="Epic" />
                        <span
                          title="Open the epic"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedKey(epic.key)
                          }}
                          className="min-w-0 truncate tracking-normal text-foreground/90 normal-case hover:underline"
                        >
                          {epic.summary}
                        </span>
                        <span className="shrink-0 font-mono font-normal tracking-normal normal-case">{epic.key}</span>
                        <span className="flex-1" />
                        <EpicProgress done={epic.children.filter((child) => child.done).length} total={epic.children.length} />
                      </>
                    ) : (
                      <>
                        No epic <span className="font-normal">{groupItems.length}</span>
                      </>
                    )
                  )}
                  {/* Nested under the epic, lined up with its name */}
                  {open && <div className="pl-5">{groupItems.map(row)}</div>}
                </div>
              )
            })}
        </div>
        <ResizeHandle width={listWidth} min={280} max={560} onResize={setListWidth} />
      </aside>
      {selected ? <Detail key={selected.key} item={selected} statuses={statuses} types={types} people={people} myName={myName ?? null} onPatch={patch(selected.key)} onChanged={refresh} /> : <EmptyState fill icon="list" title="Select a work item" />}
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
