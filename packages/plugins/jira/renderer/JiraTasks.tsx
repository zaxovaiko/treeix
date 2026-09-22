import { actionForEvent } from '@treeix/shared/keymap'
import { useEffect, useRef, useState } from 'react'
import { focusZone, isPageKey, Kbd, PageLayout, useHost, useListNav, usePanels, useZone } from '@treeix/sdk'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { EmptyState, FoldAllButton, IconButton, UserAvatar, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import type { Epic, JiraPerson, WorkItem, WorkItemList } from '../shared/types'
import { branchFor } from './branch'
import { Picker } from '@treeix/app/Picker'
import { applyPatch, type Patches, pendingPatches } from './optimistic'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { withList } from '@treeix/atlassian/renderer/panels'
import { type FilterGroup, FilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { epicCache, jiraApi, jiraSettings, LIST_LIMIT, listCache, ME, meCache, orderedJql, scopedJql, selection, summaryCache, TTL } from './api'
import { BugPill, EpicChip, EpicProgress, isBug, PriorityMark, StatusPill, TypeMark } from './marks'
import { type Bucket, BUCKETS, bucketOf, epicIndex, groupByEpic, isItemSort, projectOf, SORTS, sortItems } from './buckets'
import { COMMENT_INPUT, LABEL_INPUT, type PickerId, type StatusOption, TicketMain, useTicket } from './TicketView'

/** Returns false when it couldn't act, so the key goes on unhandled */
type KeyRun = () => boolean | void

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
const FILTER_ID = 'ticket-filter'

type GroupBy = 'status' | 'epic'

const SORT_HINTS: Record<keyof typeof SORTS, React.ReactNode> = {
  status: <span>Status <span className="text-muted-foreground">in progress first</span></span>,
  priority: <span>Priority <span className="text-muted-foreground">most urgent first</span></span>,
  updated: <span>Updated <span className="text-muted-foreground">newest first</span></span>,
  created: <span>Created <span className="text-muted-foreground">newest first</span></span>
}
/** Your own items to start with; removing the chip shows everyone's */
const DEFAULT_FILTERS: FilterToken[] = [{ kind: 'assignee', value: ME }]
const MINE: FilterToken = { kind: 'assignee', value: ME }

/** Rows the list cursor walks: group headers, which fold, and the items under open groups */
type Group = { id: string; bucket: Bucket | null; epic: Epic | null; items: WorkItem[] }
type Entry = { kind: 'group'; id: string; group: string } | { kind: 'item'; item: WorkItem; group: string }

/** False while the field isn't on screen, as while the item's details load */
const focusField = (id: string): boolean => {
  const field = document.getElementById(id)
  field?.scrollIntoView({ block: 'nearest' })
  field?.focus()
  return field !== null
}

export function JiraTasks(): React.JSX.Element {
  const { jql, statusBuckets } = jiraSettings.use()
  const host = useHost()
  const panels = usePanels()
  const { zone } = useZone()
  const { value: myName } = useCached<string | null>(meCache, 'me', TTL.me, jiraApi.me)
  const [filtersJson, setFiltersJson] = usePersisted<string>(workspaceKey('jira.filters'), JSON.stringify(DEFAULT_FILTERS))
  const filters = parseTokens(readJson(filtersJson), FILTER_KINDS)
  const setFilters = (next: FilterToken[]): void => setFiltersJson(JSON.stringify(next))
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
  const [collapsedJson, setCollapsedJson] = usePersisted<string>(workspaceKey('jira.collapsed'), '["waiting","blocked","later","done"]')
  const collapsed = parseList(collapsedJson)
  const [groupBy, setGroupBy] = usePersisted<GroupBy>(workspaceKey('jira.groupBy'), 'status')
  const [picker, setPicker] = useState<PickerId | null>(null)
  const [editingSummary, setEditingSummary] = useState(false)
  /** A group header under the list cursor; null while the cursor is on the selected item */
  const [cursorGroup, setCursorGroup] = useState<string | null>(null)

  const requested = selection.use().key
  useEffect(() => {
    if (!requested) return
    setSelectedKey(requested)
    setCursorGroup(null)
    selection.update({ key: null })
  }, [requested])

  const [patches, setPatches] = useState<Patches>({})
  // Fresh data from Jira replaces a patch once it shows the same values
  useEffect(() => setPatches((current) => pendingPatches(list?.items ?? [], current, Date.now())), [list])
  const patch = (key: string, fields: Partial<WorkItem>): (() => void) => {
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
  const bucketFor = (item: WorkItem): Bucket => bucketOf(item, inSprint(item), statusBuckets)
  const statusGroups: Group[] = (Object.keys(BUCKETS) as Bucket[])
    .map((bucket) => ({ id: bucket, bucket, epic: null, items: sortItems(visible.filter((item) => bucketFor(item) === bucket), sort) }))
    .filter((group) => group.items.length > 0)
  const bucketRank = (item: WorkItem): number => (Object.keys(BUCKETS) as Bucket[]).indexOf(bucketFor(item))
  // Inside an epic, your move comes first, as in the status view
  const epicGroups: Group[] = (groupBy === 'epic' && epics ? groupByEpic(sortItems(visible, sort).sort((a, b) => bucketRank(a) - bucketRank(b)), epics) : []).map((group) => ({
    ...group,
    id: `epic:${group.epic?.key ?? 'none'}`,
    bucket: null
  }))
  const groups: Group[] = groupBy === 'status' ? statusGroups : epicGroups
  const entries: Entry[] = groups.flatMap((group): Entry[] => [
    { kind: 'group', id: group.id, group: group.id },
    ...(collapsed.includes(group.id) ? [] : group.items.map((item): Entry => ({ kind: 'item', item, group: group.id })))
  ])

  // An item picked from elsewhere, like an epic from the detail pane, may not be in this list; it loads on its own
  const outsideKey = selectedKey && !visible.some((item) => item.key === selectedKey) ? selectedKey : ''
  const { value: outsideItem } = useCached<WorkItem>(summaryCache, outsideKey, TTL.summary, jiraApi.summary)
  const selected =
    visible.find((item) => item.key === selectedKey) ?? (outsideItem && outsideItem.key === outsideKey ? applyPatch(outsideItem, patches) : undefined) ?? groups[0]?.items[0]
  useEffect(() => setEditingSummary(false), [selected?.key])
  // Only statuses seen on listed items are known, with the category Jira gave them
  const people: JiraPerson[] = [
    ...new Map(items.flatMap((item) => (item.assigneeId && item.assignee ? [[item.assigneeId, { accountId: item.assigneeId, name: item.assignee, avatar: item.assigneeAvatar }] as const] : []))).values()
  ]
  const types = [...new Set(['Task', 'Story', 'Bug', ...items.map((item) => item.type)])].filter((type) => !/epic|sub.?task/i.test(type))
  const statuses: StatusOption[] = [...new Map(items.map((item) => [item.status, { name: item.status, category: item.statusCategory }])).values()]
  const ticket = useTicket(selected, { statuses, people, myName: myName ?? null, setPicker, onPatch: patch, onChanged: refresh })

  /** Buckets by name, epics as `epic:KEY` */
  const setCollapsed = (next: string[]): void => setCollapsedJson(JSON.stringify(next))
  const fold = (id: string, closed: boolean): void => setCollapsed(closed ? [...new Set([...collapsed, id])] : collapsed.filter((entry) => entry !== id))
  const groupIds = groups.map((group) => group.id)
  const anyOpen = groupIds.some((id) => !collapsed.includes(id))
  const foldAll = (): void => {
    const others = collapsed.filter((id) => !groupIds.includes(id))
    setCollapsed(anyOpen ? [...others, ...groupIds] : others)
  }
  const toggleMine = (): void => setFilters(mine ? filters.filter((filter) => filter.kind !== 'assignee') : [...filters.filter((filter) => filter.kind !== 'assignee'), MINE])
  const filterByEpic = (epic: Epic): void => setFilters([...filters.filter((filter) => filter.kind !== 'epic'), { kind: 'epic', value: epic.summary }])
  const moveStatus = (status: string, bucket: Bucket | null): void => {
    const { [status]: _previous, ...rest } = statusBuckets
    jiraSettings.update({ statusBuckets: bucket ? { ...rest, [status]: bucket } : rest })
  }

  const cursor = cursorGroup !== null ? entries.findIndex((entry) => entry.kind === 'group' && entry.id === cursorGroup) : entries.findIndex((entry) => entry.kind === 'item' && entry.item.key === selected?.key)
  const selectEntry = (index: number): void => {
    const entry = entries[index]
    if (entry.kind === 'group') return setCursorGroup(entry.id)
    setCursorGroup(null)
    setSelectedKey(entry.item.key)
  }
  const nav = useListNav({
    count: entries.length,
    index: cursor,
    onSelect: selectEntry,
    onOpen: (index) => {
      const entry = entries[index]
      if (entry.kind === 'group') fold(entry.id, !collapsed.includes(entry.id))
      else focusZone('main')
    }
  })

  const focusDetailField = (id: string): boolean => {
    if (focusField(id)) return true
    host.flash(ticket?.error ? `Couldn't load ${ticket.item.key}` : 'Loading ticket')
    return false
  }
  const ticketKeys: Record<string, KeyRun> = ticket
    ? {
        'jira.status': () => setPicker('status'),
        'jira.assign': () => setPicker('assignee'),
        'jira.editSummary': () => setEditingSummary(true),
        'jira.label': () => focusDetailField(LABEL_INPUT),
        'jira.comment': () => focusDetailField(COMMENT_INPUT),
        'jira.worktree': ticket.openWorktree,
        'jira.newWorktree': ticket.newWorktree,
        'jira.agentComments': ticket.addToComments,
        'jira.open': ticket.openInBrowser,
        'jira.copyBranch': ticket.copyBranch,
        'jira.type': () => setPicker('type')
      }
    : {}

  // The sort picker lives in the list, so hiding the list closes it rather than leaving it to pop up later
  useEffect(() => {
    if (!panels.list && picker === 'sort') setPicker(null)
  }, [panels.list])
  const onKey = useRef<(event: KeyboardEvent) => boolean>(() => false)
  onKey.current = (event) => {
    const entry = entries[cursor]
    const listKeys: Record<string, KeyRun> = {
      'jira.search': () => withList(panels, FILTER_ID, () => document.querySelector<HTMLInputElement>(`#${FILTER_ID} input`)?.focus()),
      'jira.mine': toggleMine,
      'jira.groupBy': () => setGroupBy(groupBy === 'status' ? 'epic' : 'status'),
      'jira.sort': () => withList(panels, FILTER_ID, () => setPicker('sort')),
      ...(zone === 'list' && groupIds.length > 1 ? { 'jira.fold': foldAll } : {})
    }
    if (zone === 'list' && entry && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      fold(entry.group, event.key === 'ArrowLeft')
      if (event.key === 'ArrowLeft') setCursorGroup(entry.group)
      return true
    }
    const id = actionForEvent(event, [...Object.keys(listKeys), ...Object.keys(ticketKeys)])
    const run = id ? (listKeys[id] ?? ticketKeys[id]) : undefined
    return run !== undefined && run() !== false
  }
  // The page keeps this listener while it sits off screen, so it only acts when the keys are its own
  const ownsKeys = useRef(false)
  ownsKeys.current = host.keyboardPage === 'tasks'
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (ownsKeys.current && isPageKey(event) && onKey.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const showAssignee = !mine
  const row = (item: WorkItem, index: number): React.JSX.Element => {
    const bucket = bucketFor(item)
    const epic = groupBy === 'status' ? epicOf.get(item.key) : undefined
    return (
      <button
        key={item.key}
        {...nav.rowProps(index)}
        onClick={() => {
          setCursorGroup(null)
          setSelectedKey(item.key)
        }}
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
        className="flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <span className="flex w-full min-w-0 items-start gap-2">
          <span className="mt-0.5">
            <TypeMark type={item.type} />
          </span>
          <span title={item.summary} className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-5 break-words">
            {item.summary}
          </span>
          {showAssignee &&
            (item.assignee ? (
              <span title={item.assignee} className="mt-0.5 shrink-0">
                <UserAvatar name={item.assignee} url={item.assigneeAvatar} size="size-4" />
              </span>
            ) : (
              <span title={UNASSIGNED} className="mt-0.5 size-4 shrink-0 rounded-full border border-dashed border-foreground/25" />
            ))}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden pl-6 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className="shrink-0 font-mono">{item.key}</span>
          {isBug(item.type) && <BugPill type={item.type} />}
          <StatusPill item={item} />
          <PriorityMark priority={item.priority} />
          {epic && <EpicChip summary={epic.summary} onClick={() => filterByEpic(epic)} />}
        </span>
      </button>
    )
  }

  const groupHeader = (group: Group, index: number): React.JSX.Element => {
    const open = !collapsed.includes(group.id)
    const { epic } = group
    return (
      <button
        key={group.id}
        {...nav.rowProps(index)}
        onClick={() => fold(group.id, open)}
        title={open ? 'Fold (←)' : 'Unfold (→)'}
        className="mt-1 flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-accent hover:text-foreground"
      >
        <Icon name="chevron" className={`size-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
        {group.bucket && <span className="truncate">{BUCKETS[group.bucket]}</span>}
        {epic && (
          <>
            <TypeMark type="Epic" />
            <span
              title={`Open ${epic.key}: ${epic.summary}`}
              onClick={(event) => {
                event.stopPropagation()
                setCursorGroup(null)
                setSelectedKey(epic.key)
              }}
              className="min-w-0 truncate tracking-normal text-foreground/90 normal-case hover:underline"
            >
              {epic.summary}
            </span>
          </>
        )}
        {!group.bucket && !epic && <span className="truncate">No epic</span>}
        <span className="shrink-0 font-normal tabular-nums">{group.items.length}</span>
        <span className="flex-1" />
        {epic && <EpicProgress done={epic.children.filter((child) => child.done).length} total={epic.children.length} />}
      </button>
    )
  }

  const segment = (mode: GroupBy, label: string): React.JSX.Element => (
    <button
      key={mode}
      onClick={() => setGroupBy(mode)}
      className={`h-6 rounded-md px-2 ${groupBy === mode ? 'bg-foreground/10 font-medium text-foreground' : 'hover:text-foreground'}`}
    >
      {label}
    </button>
  )

  const listPane = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Tasks</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{visible.length}</span>
        <span className="flex-1" />
        {groupIds.length > 1 && <FoldAllButton anyOpen={anyOpen} onClick={foldAll} />}
        <IconButton label={loading ? 'Refreshing...' : 'Refresh'} onClick={refresh}>
          <Icon name="refresh" className={`size-3.5 ${loading ? 'opacity-40' : ''}`} />
        </IconButton>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div
          id={FILTER_ID}
          className="flex min-w-0"
          // Esc leaves the search for the list, where j/k go on
          onKeyDown={(event) => event.key === 'Escape' && event.currentTarget.closest<HTMLElement>('[data-zone]')?.focus()}
        >
          <FilterSearch
            items={items}
            groups={groupsForFilter}
            tokens={filters}
            onChange={setFilters}
            placeholder="Search Jira (/), or filter by person, project, status"
            freeTextHint="Press ↵ to search Jira for this text"
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5" title="Group by (v)">
            {segment('status', 'Whose move')}
            {segment('epic', 'Epic')}
          </span>
          <Kbd hint>v</Kbd>
          <button
            onClick={toggleMine}
            title="Only assigned to me (f)"
            className={`ml-1 flex h-6 items-center gap-1 rounded-md px-2 ring-1 ${mine ? 'bg-foreground/10 text-foreground ring-border' : 'ring-border hover:text-foreground'}`}
          >
            Mine <Kbd hint>f</Kbd>
          </button>
          <span className="flex-1" />
          <Picker
            title="Sort (⇧S)"
            trigger={
              <span className="flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-accent hover:text-foreground">
                <Icon name="sort" className="size-3" />
                {SORTS[sort]}
                <Kbd hint>⇧S</Kbd>
              </span>
            }
            options={(Object.keys(SORTS) as (keyof typeof SORTS)[]).map((id) => ({ id, label: SORTS[id], section: '', render: SORT_HINTS[id] }))}
            current={sort}
            placeholder="Sort by..."
            width="w-56"
            align="right"
            open={picker === 'sort'}
            onOpenChange={(open) => setPicker(open ? 'sort' : null)}
            onPick={setSort}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {error && <p className="px-2 py-3 text-xs break-words text-amber-400 select-text">{error}</p>}
        {!list && !error && <EmptyState title="Loading tasks..." />}
        {list && visible.length === 0 && <EmptyState title="No tasks match" />}
        {items.length >= LIST_LIMIT && <p className="px-2 pt-3 text-[11px] text-muted-foreground">Jira returned the first {LIST_LIMIT} items. Filter by project or person to see the rest.</p>}
        {groupBy === 'epic' && !epics && list && <p className="px-2 py-3 text-[11px] text-muted-foreground">Loading epics...</p>}
        {entries.map((entry, index) => {
          if (entry.kind === 'item') return row(entry.item, index)
          const group = groups.find((candidate) => candidate.id === entry.id)
          return group ? groupHeader(group, index) : null
        })}
      </div>
    </>
  )

  return (
    <PageLayout
      listLabel="Tasks"
      listWidth={400}
      hints={{
        list: [['j k', 'move'], ['← →', 'fold'], ['/', 'search'], ['f', 'mine'], ['v', 'group']],
        main: [['s', 'status'], ['u', 'assign'], ['e', 'edit'], ['c', 'comment'], ['w', 'worktree'], ['a', 'to agent']]
      }}
      list={listPane}
      main={
        <TicketMain
          ticket={ticket}
          epic={selected ? epicOf.get(selected.key) : undefined}
          statuses={statuses}
          types={types}
          people={people}
          picker={picker}
          setPicker={setPicker}
          editingSummary={editingSummary}
          setEditingSummary={setEditingSummary}
        />
      }
    />
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
