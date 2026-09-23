import { actionForEvent, matchesAction } from '@treeix/shared/keymap'
import { useEffect, useRef, useState } from 'react'
import { focusZone, isPageKey, Kbd, ListToggle, PageLayout, useHost, useListNav, usePanels, useZone } from '@treeix/sdk'
import { copyText } from '@treeix/app/contextMenu'
import { type FilterGroup, FilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown, MarkdownFoldButton, MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import { EmptyState, FoldAllButton, IconButton, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import type { Page, PageList, PageSummary } from '../shared/types'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { withList } from '@treeix/atlassian/renderer/panels'
import { confluenceApi, openRequest, pageCache, pageOfUrl, recentCache, resolveImage, TTL } from './api'

const MAX_OPENED = 20
/** Pages shown per space before "Show more" */
const PER_SPACE = 6
const SEARCH_ID = 'confluence-search'
const BODY_ID = 'confluence-body'

const ROW = 'flex w-full min-w-0 items-center gap-2 rounded-md text-left hover:bg-accent'

const RESULTS = 'Results'
/** A listed page and the section listing it */
type Known = { page: PageSummary; source: string }
// Text is searched by Confluence, so it matches every page it returned
const FILTER_GROUPS: FilterGroup<Known>[] = [
  { kind: 'space', label: 'Space', valueOf: (known) => known.page.space },
  { kind: 'source', label: 'List', valueOf: (known) => (known.source === RESULTS ? null : known.source) },
  { kind: 'text', label: 'Text', valueOf: () => null, freeText: () => true }
]
const FILTER_KINDS = FILTER_GROUPS.map((group) => group.kind)

function readJson(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** A pasted page URL or id, which opens the page instead of searching */
const directId = (text: string): string | null => pageOfUrl(text)?.id ?? (/^\d{4,}$/.test(text) ? text : null)

function parseStrings(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function parseOpened(json: string): PageSummary[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((entry): entry is PageSummary => typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && typeof entry.title === 'string') : []
  } catch {
    return []
  }
}

/** Pages of one space together, spaces in alphabetical order with unknown ones last */
function bySpace(list: PageSummary[]): [string, PageSummary[]][] {
  const spaces = new Map<string, PageSummary[]>()
  for (const page of list) spaces.set(page.space ?? '', [...(spaces.get(page.space ?? '') ?? []), page])
  return [...spaces].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
}

/** Rows the list cursor walks: section titles and errors are not stops, space folders and pages are */
type Entry =
  | { kind: 'space'; id: string; space: string; count: number; open: boolean }
  | { kind: 'page'; id: string; page: PageSummary; space: string }
  | { kind: 'more'; id: string; space: string; hidden: number }
type Section = { title: string; error: string | null; count: number; entries: Entry[] }


function PageMain({ page, parent, error, onReload, onAgent, onCopy }: { page: Page | null; parent: Page | null; error: string | null; onReload: () => void; onAgent: () => void; onCopy: () => void }): React.JSX.Element {
  if (!page) return error ? <EmptyState fill icon="file" title={error} /> : <EmptyState fill title="Loading page..." />
  return (
    <MarkdownFoldScope>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-1.5 text-xs text-muted-foreground">
        <ListToggle />
        {parent && (
          <>
            <button onClick={() => openRequest.update({ id: parent.id })} title={`Open ${parent.title}`} className="max-w-[40%] min-w-0 truncate rounded px-1 hover:text-foreground">
              {parent.title}
            </button>
            <span className="text-muted-foreground/40">/</span>
          </>
        )}
        <span className="min-w-0 truncate text-foreground">{page.title}</span>
        <span className="flex-1" />
        <MarkdownFoldButton />
        <IconButton label="Reload page (r)" onClick={onReload}>
          <Icon name="refresh" className="size-3.5" />
        </IconButton>
        <button onClick={onAgent} title="Add to agent comments (a)" className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] ring-1 ring-border hover:bg-accent hover:text-foreground">
          <Icon name="comment" className="size-3" />
          To agent
          <Kbd hint>a</Kbd>
        </button>
        <IconButton label="Copy link (y)" onClick={onCopy}>
          <Icon name="copy" className="size-3.5" />
        </IconButton>
        <button onClick={() => window.open(page.url, '_blank')} title="Open in Confluence (o)" className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent hover:text-foreground">
          <Icon name="external" className="size-3" />
          <Kbd hint>o</Kbd>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[760px] min-w-0 px-8 py-6">
          <h1 className="text-[22px] leading-8 font-semibold break-words select-text">{page.title}</h1>
          <div className="mt-1 mb-4 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {page.space && <span className="truncate">{page.space}</span>}
            {page.space && page.updatedAt && <span>·</span>}
            {page.updatedAt && <span className="shrink-0">Updated {timeAgo(page.updatedAt)} ago</span>}
          </div>
          <div id={BODY_ID}>{page.body ? <Markdown resolveImage={resolveImage}>{page.body}</Markdown> : <p className="text-xs text-muted-foreground">This page is empty</p>}</div>
          {page.children.length > 0 && (
            <section className="mt-6">
              <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Child pages</h3>
              {page.children.map((child) => (
                <button key={child.id} onClick={() => openRequest.update({ id: child.id })} className={`${ROW} -mx-2 h-8 px-2 text-[13px]`}>
                  <Icon name="file" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{child.title}</span>
                </button>
              ))}
            </section>
          )}
          <LinkPreviews urls={page.links} exclude={[page.id]} />
        </article>
      </div>
    </MarkdownFoldScope>
  )
}

/** `id` names the key in the keymap, so Settings can rebind it */
type PageAction = { label: string; id: string; run: () => void }


export function ConfluenceTab(): React.JSX.Element {
  const host = useHost()
  const panels = usePanels()
  const { zone } = useZone()
  const [filtersJson, setFiltersJson] = usePersisted<string>(workspaceKey('confluence.filters'), '[]')
  const filters = parseTokens(readJson(filtersJson), FILTER_KINDS)
  const valuesOf = (kind: string): string[] => filters.filter((filter) => filter.kind === kind).map((filter) => filter.value)
  const texts = valuesOf('text')
  const spaceFilters = valuesOf('space')
  const [results, setResults] = useState<PageList | null>(null)
  const { value: recent, error: recentError, loading: recentLoading, refresh: reloadRecent } = useCached<PageList>(recentCache, 'recent', TTL.recent, confluenceApi.recent)
  const [selectedId, setSelectedId] = usePersisted<string>(workspaceKey('confluence.selected'), '')
  const [openedJson, setOpenedJson] = usePersisted<string>(workspaceKey('confluence.opened'), '[]')
  const [collapsedJson, setCollapsedJson] = usePersisted<string>(workspaceKey('confluence.collapsedSpaces'), '[]')
  const [expandedJson, setExpandedJson] = usePersisted<string>(workspaceKey('confluence.expandedSpaces'), '[]')
  /** The list row under the cursor; a page can be listed twice, in Opened here and Recently viewed */
  const [cursorId, setCursorId] = useState<string | null>(null)
  const collapsedSpaces = parseStrings(collapsedJson)
  const expandedSpaces = parseStrings(expandedJson)
  const fold = (space: string, closed: boolean): void =>
    setCollapsedJson(JSON.stringify(closed ? [...new Set([...collapsedSpaces, space])] : collapsedSpaces.filter((entry) => entry !== space)))
  const showAll = (space: string): void => setExpandedJson(JSON.stringify([...expandedSpaces, space]))
  const opened = parseOpened(openedJson)
  const requested = openRequest.use().id
  const { value: page, error: pageError, refresh: reloadPage } = useCached<Page>(pageCache, selectedId, TTL.page, confluenceApi.page)
  const shownPage = page?.id === selectedId ? page : null
  const { value: parent } = useCached<Page>(pageCache, shownPage?.parentId ?? '', TTL.page, confluenceApi.page)

  const open = (id: string, cursor: string | null = null): void => {
    setSelectedId(id)
    setCursorId(cursor)
  }

  useEffect(() => {
    if (!requested) return
    open(requested)
    openRequest.update({ id: null })
  }, [requested])

  // What was opened here comes back first next time; walking the list keeps its order, so the cursor can go on
  useEffect(() => {
    if (!shownPage) return
    const summary: PageSummary = { id: shownPage.id, title: shownPage.title, space: shownPage.space, lastModified: shownPage.updatedAt }
    const list = parseOpened(openedJson)
    const known = list.some((entry) => entry.id === summary.id)
    const next = known && cursorId !== null ? list.map((entry) => (entry.id === summary.id ? summary : entry)) : [summary, ...list.filter((entry) => entry.id !== summary.id)].slice(0, MAX_OPENED)
    setOpenedJson(JSON.stringify(next))
  }, [shownPage?.id, shownPage?.title, shownPage?.space])

  // A pasted page URL or id opens directly through acli; other text searches, which needs the API token
  const setFilters = (next: FilterToken[]): void => {
    const direct = next.flatMap((filter) => (filter.kind === 'text' ? [directId(filter.value)] : [])).find((id) => id !== null)
    if (direct) open(direct)
    setFiltersJson(JSON.stringify(next.filter((filter) => filter.kind !== 'text' || !directId(filter.value))))
  }

  const searchKey = texts.length > 0 ? JSON.stringify([texts, spaceFilters]) : ''
  useEffect(() => {
    if (!searchKey) return setResults(null)
    let current = true
    void confluenceApi.search(texts, spaceFilters).then((list) => current && setResults(list))
    return () => {
      current = false
    }
  }, [searchKey])

  const section = (title: string, all: PageSummary[], error: string | null = null): Section => {
    // Results already are the search, so which list a page came from doesn't apply to them
    const tokens = title === RESULTS ? filters.filter((filter) => filter.kind !== 'source') : filters
    const list = all.filter((page) => matchesTokens({ page, source: title }, tokens, FILTER_GROUPS))
    const entries = bySpace(list).flatMap(([space, pages]): Entry[] => {
      const key = `${title}:${space}`
      const isOpen = !collapsedSpaces.includes(key)
      const shown = expandedSpaces.includes(key) ? pages : pages.slice(0, PER_SPACE)
      return [
        { kind: 'space', id: key, space: key, count: pages.length, open: isOpen },
        ...(isOpen ? shown.map((summary): Entry => ({ kind: 'page', id: `${key}:${summary.id}`, page: summary, space: key })) : []),
        ...(isOpen && shown.length < pages.length ? [{ kind: 'more', id: `${key}:more`, space: key, hidden: pages.length - shown.length } as const] : [])
      ]
    })
    return { title, error, count: list.length, entries }
  }
  const known: Known[] = [
    ...opened.map((page) => ({ page, source: 'Opened here' })),
    ...(recent?.pages ?? []).map((page) => ({ page, source: 'Recently viewed' })),
    ...(results?.pages ?? []).map((page) => ({ page, source: RESULTS }))
  ]
  const sections = (results ? [section(RESULTS, results.pages, results.error)] : [section('Opened here', opened), section('Recently viewed', recent?.pages ?? [], recentError)]).filter(
    (candidate) => candidate.entries.length > 0 || candidate.error
  )
  const entries = sections.flatMap((candidate) => candidate.entries)
  const byCursor = cursorId === null ? -1 : entries.findIndex((entry) => entry.id === cursorId)
  const cursor = byCursor >= 0 ? byCursor : entries.findIndex((entry) => entry.kind === 'page' && entry.page.id === selectedId)
  const activate = (entry: Entry): void => {
    if (entry.kind === 'space') fold(entry.space, entry.open)
    if (entry.kind === 'more') showAll(entry.space)
    if (entry.kind === 'page') focusZone('main')
  }
  const nav = useListNav({
    count: entries.length,
    index: cursor,
    onSelect: (index) => {
      const entry = entries[index]
      if (entry.kind === 'page') open(entry.page.id, entry.id)
      else setCursorId(entry.id)
    },
    onOpen: (index) => activate(entries[index])
  })

  const addToComments = (): void => {
    if (!shownPage) return
    const worktreePath = host.selectedWorktree
    if (!worktreePath) return host.flash('Select a worktree first')
    host.addComment({
      id: crypto.randomUUID(),
      worktreePath,
      filePath: `Confluence: ${shownPage.title}`,
      range: { start: 0, end: 0 },
      code: '',
      // The reference alone keeps the prompt short; the page text rides along for machines without acli
      text: `Confluence "${shownPage.title}" ${shownPage.url}`,
      body: shownPage.body,
      tool: 'acli',
      kind: 'reference'
    })
    host.flash(`Added ${shownPage.title} to comments on ${baseName(worktreePath)}`)
  }

  const search: PageAction = {
    label: 'Search',
    id: 'confluence.search',
    run: () => withList(panels, SEARCH_ID, () => document.querySelector<HTMLInputElement>(`#${SEARCH_ID} input`)?.focus())
  }
  const copyLink = (): void => {
    if (!shownPage) return
    copyText(shownPage.url)
    host.flash('Copied the page link')
  }
  // What the open page can do by key; the header has a button for each
  const actions: PageAction[] = shownPage
    ? [
        { label: 'Add to agent comments', id: 'confluence.agentComments', run: addToComments },
        { label: 'Open in Confluence', id: 'confluence.open', run: () => window.open(shownPage.url, '_blank') },
        {
          label: 'Copy link',
          id: 'confluence.copyLink',
          run: copyLink
        },
        { label: 'Reload page', id: 'confluence.reload', run: reloadPage }
      ]
    : []

  const spaceKeys = sections.flatMap((entrySection) => entrySection.entries.flatMap((entry) => (entry.kind === 'space' ? [entry.space] : [])))
  const anySpaceOpen = spaceKeys.some((key) => !collapsedSpaces.includes(key))
  const foldAll = (): void => setCollapsedJson(JSON.stringify(anySpaceOpen ? [...new Set([...collapsedSpaces, ...spaceKeys])] : collapsedSpaces.filter((key) => !spaceKeys.includes(key))))

  const onKey = useRef<(event: KeyboardEvent) => boolean>(() => false)
  onKey.current = (event) => {
    if (zone === 'list' && matchesAction(event, 'confluence.fold') && spaceKeys.length > 1) {
      foldAll()
      return true
    }
    const entry = entries[cursor]
    if (zone === 'list' && entry && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      fold(entry.space, event.key === 'ArrowLeft')
      if (event.key === 'ArrowLeft') setCursorId(entry.space)
      return true
    }
    const all = [...actions, search]
    const id = actionForEvent(event, all.map((action) => action.id))
    const run = all.find((action) => action.id === id)?.run
    run?.()
    return run !== undefined
  }
  // The page keeps this listener while it sits off screen, so it only acts when the keys are its own
  const ownsKeys = useRef(false)
  ownsKeys.current = host.keyboardPage === 'confluence'
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (ownsKeys.current && isPageKey(event) && onKey.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const row = (entry: Entry, index: number): React.JSX.Element => {
    if (entry.kind === 'space') {
      const name = entry.space.slice(entry.space.indexOf(':') + 1)
      return (
        <button key={entry.id} {...nav.rowProps(index)} onClick={() => fold(entry.space, entry.open)} title={entry.open ? 'Fold (←)' : 'Unfold (→)'} className={`${ROW} mt-1 h-6 px-2 text-[11px] text-muted-foreground`}>
          <Icon name="chevron" className={`size-3 shrink-0 ${entry.open ? 'rotate-90' : ''}`} />
          <Icon name="folder" className="size-3 shrink-0" />
          <span className="truncate">{name || 'Other'}</span>
          <span className="shrink-0 tabular-nums opacity-70">{entry.count}</span>
        </button>
      )
    }
    if (entry.kind === 'more') {
      return (
        <button key={entry.id} {...nav.rowProps(index)} onClick={() => showAll(entry.space)} className={`${ROW} h-6 pl-7 text-[11px] text-muted-foreground`}>
          Show {entry.hidden} more
        </button>
      )
    }
    return (
      <button key={entry.id} {...nav.rowProps(index)} onClick={() => open(entry.page.id, entry.id)} title={entry.page.title} className={`${ROW} h-7 pr-2 pl-7 text-xs`}>
        <Icon name="file" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{entry.page.title}</span>
        {entry.page.lastModified && <span className="shrink-0 text-[10.5px] text-muted-foreground">{timeAgo(entry.page.lastModified)}</span>}
      </button>
    )
  }

  let index = -1
  const listPane = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Confluence</span>
        <span className="flex-1" />
        {spaceKeys.length > 1 && (
          <FoldAllButton anyOpen={anySpaceOpen} groups="spaces" onClick={foldAll} />
        )}
        <IconButton label={recentLoading ? 'Reloading...' : 'Reload recently viewed'} onClick={reloadRecent}>
          <Icon name="refresh" className={`size-3.5 ${recentLoading ? 'opacity-40' : ''}`} />
        </IconButton>
      </div>
      <div className="shrink-0 border-b border-border p-2">
        <div
          id={SEARCH_ID}
          className="flex min-w-0"
          onKeyDownCapture={(event) => {
            // With nothing typed, Enter or ↓ goes on to the first page, where j/k continue
            const first = entries.find((entry) => entry.kind === 'page')
            const typed = event.target instanceof HTMLInputElement && event.target.value !== ''
            if ((event.key === 'Enter' || event.key === 'ArrowDown') && !typed && first?.kind === 'page') {
              event.preventDefault()
              event.stopPropagation()
              open(first.page.id, first.id)
              event.currentTarget.closest<HTMLElement>('[data-zone]')?.focus()
            }
          }}
          // Esc leaves the search for the list
          onKeyDown={(event) => event.key === 'Escape' && event.currentTarget.closest<HTMLElement>('[data-zone]')?.focus()}
        >
          <FilterSearch
            items={known}
            groups={FILTER_GROUPS}
            tokens={filters}
            onChange={setFilters}
            placeholder="Search (/), filter by space, or paste a page link or id"
            freeTextHint="Press ↵ to search Confluence for this text"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {(results || filters.length > 0) && sections.length === 0 && <EmptyState title="No pages found" />}
        {sections.map((candidate) => (
          <div key={candidate.title}>
            <div className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {candidate.title} {results && <span className="font-normal">{candidate.count}</span>}
            </div>
            {candidate.error && <p className="px-2 pb-2 text-xs break-words text-amber-400 select-text">{candidate.error}</p>}
            {candidate.entries.map((entry) => row(entry, ++index))}
          </div>
        ))}
      </div>
    </>
  )

  return (
    <PageLayout
      list={listPane}
      main={selectedId ? <PageMain page={shownPage} parent={parent} error={pageError} onReload={reloadPage} onAgent={addToComments} onCopy={copyLink} /> : <EmptyState fill icon="file" title="Pick a page or paste a Confluence link" />}
    />
  )
}
