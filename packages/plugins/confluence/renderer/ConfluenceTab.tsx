import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { copyText } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import { EmptyState, IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import { workspaceKey } from '@treeix/app/workspaces'
import type { Page, PageList, PageSummary } from '../shared/types'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { confluenceApi, openRequest, pageCache, pageOfUrl, recentCache, resolveImage, TTL } from './api'

const MAX_OPENED = 20
/** Pages shown per space before "Show more" */
const PER_SPACE = 6

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

function PageView({ id, onOpen }: { id: string; onOpen: (page: Page) => void }): React.JSX.Element {
  const host = useHost()
  const { value: page, error, refresh } = useCached<Page>(pageCache, id, TTL.page, confluenceApi.page)
  const { value: parent } = useCached<Page>(pageCache, page?.parentId ?? '', TTL.page, confluenceApi.page)

  useEffect(() => {
    if (page) onOpen(page)
  }, [page?.id, page?.title, page?.space])

  const addToComments = (): void => {
    if (!page) return
    const worktreePath = host.selectedWorktree
    if (!worktreePath) return host.flash('Select a worktree first')
    host.addComment({ id: crypto.randomUUID(), worktreePath, filePath: `Confluence: ${page.title}`, range: { start: 0, end: 0 }, code: '', text: `Read the Confluence page "${page.title}" (${page.url}):\n\n${page.body}` })
    host.flash(`Added ${page.title} to comments on ${baseName(worktreePath)}`)
  }

  if (!page) return error ? <EmptyState fill icon="file" title={error} /> : <EmptyState fill title="Loading page..." />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {parent && (
            <button onClick={() => openRequest.update({ id: parent.id })} className="flex min-w-0 items-center gap-1 hover:text-foreground">
              <Icon name="chevron" className="size-3 rotate-180" />
              <span className="truncate">{parent.title}</span>
            </button>
          )}
          <span className="flex-1" />
          {page.updatedAt && <span>Updated {timeAgo(page.updatedAt)} ago</span>}
          <IconButton label="Reload page" onClick={refresh}>
            <Icon name="refresh" className="size-3.5" />
          </IconButton>
          <IconButton label="Copy link" onClick={() => copyText(page.url)}>
            <Icon name="copy" className="size-3.5" />
          </IconButton>
          <a href={page.url} target="_blank" rel="noreferrer" className="flex h-7 items-center gap-1.5 rounded-md px-2.5 ring-1 ring-input hover:bg-accent">
            Open in Confluence <Icon name="external" className="size-3" />
          </a>
        </div>
        <h1 className="mt-2 text-xl font-semibold select-text">{page.title}</h1>
        <div className="mt-3 flex gap-2">
          <button onClick={addToComments} className="h-7 rounded-md px-3 text-xs ring-1 ring-input hover:bg-accent">
            Add to agent comments
          </button>
        </div>
        {page.children.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {page.children.map((child) => (
              <button key={child.id} onClick={() => openRequest.update({ id: child.id })} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
                <Icon name="file" className="size-3 text-sky-400" />
                {child.title}
              </button>
            ))}
          </div>
        )}
        <div className="mt-5">{page.body ? <Markdown resolveImage={resolveImage}>{page.body}</Markdown> : <p className="text-xs text-muted-foreground">This page is empty</p>}</div>
        <LinkPreviews urls={page.links} exclude={[page.id]} />
      </div>
    </div>
  )
}

export function ConfluenceTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PageList | null>(null)
  const { value: recent, error: recentError } = useCached<PageList>(recentCache, 'recent', TTL.recent, confluenceApi.recent)
  const [selectedId, setSelectedId] = usePersisted<string>(workspaceKey('confluence.selected'), '')
  const [openedJson, setOpenedJson] = usePersisted<string>(workspaceKey('confluence.opened'), '[]')
  const [listWidth, setListWidth] = usePersisted<number>('confluence.listWidth', 320)
  const [collapsedJson, setCollapsedJson] = usePersisted<string>(workspaceKey('confluence.collapsedSpaces'), '[]')
  const [expandedJson, setExpandedJson] = usePersisted<string>(workspaceKey('confluence.expandedSpaces'), '[]')
  const collapsedSpaces = parseStrings(collapsedJson)
  const expandedSpaces = parseStrings(expandedJson)
  const toggleSpace = (space: string): void =>
    setCollapsedJson(JSON.stringify(collapsedSpaces.includes(space) ? collapsedSpaces.filter((entry) => entry !== space) : [...collapsedSpaces, space]))
  const showAll = (space: string): void => setExpandedJson(JSON.stringify([...expandedSpaces, space]))
  const opened = parseOpened(openedJson)
  const requested = openRequest.use().id

  useEffect(() => {
    if (!requested) return
    setSelectedId(requested)
    openRequest.update({ id: null })
  }, [requested])

  // A pasted page URL or id opens directly through acli; anything else searches, which needs the API token
  useEffect(() => {
    const trimmed = query.trim()
    const direct = pageOfUrl(trimmed)?.id ?? (/^\d{4,}$/.test(trimmed) ? trimmed : null)
    if (direct) {
      setSelectedId(direct)
      setQuery('')
      return
    }
    if (trimmed.length < 2) return setResults(null)
    const timer = setTimeout(() => void confluenceApi.search(trimmed).then(setResults), 300)
    return () => clearTimeout(timer)
  }, [query])

  const remember = (page: Page): void =>
    setOpenedJson(
      JSON.stringify([{ id: page.id, title: page.title, space: page.space, lastModified: page.updatedAt }, ...parseOpened(openedJson).filter((entry) => entry.id !== page.id)].slice(0, MAX_OPENED))
    )

  const row = (page: PageSummary): React.JSX.Element => (
    <button
      key={page.id}
      onClick={() => setSelectedId(page.id)}
      className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${page.id === selectedId ? 'bg-foreground/8 ring-1 ring-border' : 'hover:bg-accent'}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="file" className="size-3.5 shrink-0 text-sky-400" />
        <span className="truncate text-[13px]">{page.title}</span>
      </span>
      {page.lastModified && <span className="truncate pl-[22px] text-[11px] text-muted-foreground">{timeAgo(page.lastModified)} ago</span>}
    </button>
  )

  /** Pages of one space together, spaces in alphabetical order with unknown ones last */
  const bySpace = (list: PageSummary[]): [string, PageSummary[]][] => {
    const spaces = new Map<string, PageSummary[]>()
    for (const page of list) spaces.set(page.space ?? '', [...(spaces.get(page.space ?? '') ?? []), page])
    return [...spaces].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  }

  const section = (title: string, list: PageSummary[], error?: string | null): React.JSX.Element | null =>
    list.length > 0 || error ? (
      <div>
        <div className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
        {error && <p className="px-2 pb-2 text-xs break-words text-amber-400 select-text">{error}</p>}
        {bySpace(list).map(([space, pages]) => {
          const key = `${title}:${space}`
          const open = !collapsedSpaces.includes(key)
          const shown = expandedSpaces.includes(key) ? pages : pages.slice(0, PER_SPACE)
          return (
            <div key={space || 'unknown'}>
              <button
                onClick={() => toggleSpace(key)}
                className="flex w-full items-center gap-1.5 px-2 pt-2 pb-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                <Icon name="folder" className="size-3" />
                <span className="truncate">{space || 'Other'}</span>
                <span className="tabular-nums opacity-70">{pages.length}</span>
              </button>
              {open && shown.map(row)}
              {open && shown.length < pages.length && (
                <button onClick={() => showAll(key)} className="w-full rounded-lg px-2.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  Show {pages.length - shown.length} more
                </button>
              )}
            </div>
          )
        })}
      </div>
    ) : null

  return (
    <div className="flex min-h-0 flex-1">
      <aside style={{ width: listWidth }} className="relative flex shrink-0 flex-col border-r border-border bg-card">
        <div className="p-2.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search, or paste a page link or id"
            className="h-8 w-full rounded-lg bg-muted px-2.5 text-[12.5px] ring-1 ring-border outline-none placeholder:text-muted-foreground/70 focus:ring-primary/60"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {results ? (
            section(`Results ${results.pages.length}`, results.pages, results.error) ?? <EmptyState title="No pages found" />
          ) : (
            <>
              {section('Opened here', opened)}
              {section('Recently viewed', recent?.pages ?? [], recentError)}
            </>
          )}
        </div>
        <ResizeHandle width={listWidth} min={240} max={520} onResize={setListWidth} />
      </aside>
      {selectedId ? <PageView key={selectedId} id={selectedId} onOpen={remember} /> : <EmptyState fill icon="file" title="Pick a page or paste a Confluence link" />}
    </div>
  )
}
