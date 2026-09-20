import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchMatch, SearchOptions, SearchResult } from '../../shared/types'
import { ancestorFolders, buildFolderTree, type FolderNode } from './fileTree'
import { FileIcon, Icon } from './Icon'
import { activeTheme } from './settings'
import { baseName } from './Sidebar'
import { codeTheme } from './themes'
import { errorMessage, usePersisted } from './ui'
import { matcherFor } from './searchMatcher'
import { workspaceKey } from './workspaces'

const SEARCH_DEBOUNCE_MS = 250

type Token = { content: string; color?: string }
// ponytail: FIFO cap, not LRU; an evicted line just tokenizes again
const TOKEN_CACHE_MAX = 50
const tokenCache = new Map<string, Token[]>()

/** One line tokenized with the diff theme; the language comes from the file name */
async function tokenizeLine(text: string, path: string): Promise<Token[]> {
  const lang = getFiletypeFromFileName(path)
  const theme = codeTheme(activeTheme())
  const key = `${theme}\0${lang}\0${text}`
  const cached = tokenCache.get(key)
  if (cached) return cached
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: [lang] })
  const tokens = (highlighter.codeToTokensBase(text, { lang, theme })[0] ?? []).map(({ content, color }) => ({ content, color }))
  tokenCache.set(key, tokens)
  if (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value!)
  return tokens
}

const matchRanges = (text: string, matcher: RegExp | null): [number, number][] =>
  matcher ? [...text.matchAll(matcher)].filter((match) => match[0] !== '' && match.index !== undefined).map((match) => [match.index, match.index + match[0].length]) : []

/** A result line: syntax colors from the file's language, with query matches marked on top */
function CodeLine({ text, path, matcher }: { text: string; path: string; matcher: RegExp | null }): React.JSX.Element {
  const [tokens, setTokens] = useState<Token[]>(() => [{ content: text }])
  useEffect(() => {
    let cancelled = false
    tokenizeLine(text, path).then(
      (next) => !cancelled && setTokens(next),
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [text, path])

  const ranges = matchRanges(text, matcher)
  const parts: React.ReactNode[] = []
  let offset = 0
  for (const token of tokens) {
    const end = offset + token.content.length
    // Split the token wherever a match starts or ends inside it
    const cuts = [offset, ...ranges.flat().filter((cut) => cut > offset && cut < end), end]
    for (let index = 0; index < cuts.length - 1; index++) {
      const [from, to] = [cuts[index], cuts[index + 1]]
      const marked = ranges.some(([start, stop]) => from >= start && to <= stop)
      parts.push(
        <span key={from} style={{ color: token.color }} className={marked ? 'rounded-sm bg-amber-400/25' : undefined}>
          {text.slice(from, to)}
        </span>
      )
    }
    offset = end
  }
  return <>{parts}</>
}


const GROUP_HEIGHT = 28
const ROW_HEIGHT = 24
const OVERSCAN = 10

/** First index whose offset is greater than `value` */
function upperBound(offsets: number[], value: number): number {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle] <= value) low = middle + 1
    else high = middle
  }
  return low
}

type Item =
  | { type: 'folder'; key: string; name: string; title: string; depth: number; count: number }
  | { type: 'group'; key: string; inFile: SearchMatch[]; depth: number }
  | { type: 'row'; location: SearchMatch; depth: number }

const toggleKey = (set: Set<string>, key: string): Set<string> => {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

const groupKey = (location: SearchMatch): string => `${location.worktreePath}\0${location.path}`

/** VS Code style results: locations grouped by file on the left, the picked one previewed on the right */
export function LocationsDialog({
  header,
  locations,
  emptyText,
  matcher,
  renderPreview,
  onPick,
  onClose
}: {
  header: React.ReactNode
  locations: SearchMatch[]
  emptyText?: string
  matcher: RegExp | null
  renderPreview: (location: SearchMatch) => React.JSX.Element
  onPick: (location: SearchMatch) => void
  onClose: () => void
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  /** Folders and files start collapsed; only the path to the first result is opened */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const multipleWorktrees = useMemo(() => new Set(locations.map((location) => location.worktreePath)).size > 1, [locations])
  const byGroup = useMemo(() => {
    const groups = new Map<string, SearchMatch[]>()
    for (const location of locations) {
      const key = groupKey(location)
      const inFile = groups.get(key)
      if (inFile) inFile.push(location)
      else groups.set(key, [location])
    }
    return groups
  }, [locations])
  const trees = useMemo(() => {
    const byWorktree = new Map<string, SearchMatch[][]>()
    for (const inFile of byGroup.values()) {
      const files = byWorktree.get(inFile[0].worktreePath)
      if (files) files.push(inFile)
      else byWorktree.set(inFile[0].worktreePath, [inFile])
    }
    return [...byWorktree].map(([worktreePath, files]) => ({ worktreePath, files, tree: buildFolderTree(files, (inFile) => inFile[0].path) }))
  }, [byGroup])

  /** Folder and file headers plus rows in tree order; `isOpen` decides which groups show their children */
  const flatten = (isOpen: (key: string) => boolean): Item[] => {
    const items: Item[] = []
    const count = (folder: FolderNode<SearchMatch[]>): number =>
      folder.files.reduce((sum, inFile) => sum + inFile.length, 0) + folder.folders.reduce((sum, child) => sum + count(child), 0)
    const walk = (node: FolderNode<SearchMatch[]>, depth: number, prefix: string): void => {
      for (const folder of node.folders) {
        const key = `${prefix}\0${folder.path}/`
        items.push({ type: 'folder', key, name: folder.name, title: folder.path, depth, count: count(folder) })
        if (isOpen(key)) walk(folder, depth + 1, prefix)
      }
      for (const inFile of node.files) {
        const key = groupKey(inFile[0])
        items.push({ type: 'group', key, inFile, depth })
        if (isOpen(key)) for (const location of inFile) items.push({ type: 'row', location, depth: depth + 1 })
      }
    }
    for (const { worktreePath, files, tree } of trees) {
      if (!multipleWorktrees) {
        walk(tree, 0, worktreePath)
        continue
      }
      const key = `${worktreePath}\0`
      items.push({ type: 'folder', key, name: baseName(worktreePath), title: worktreePath, depth: 0, count: files.reduce((sum, inFile) => sum + inFile.length, 0) })
      if (isOpen(key)) walk(tree, 1, worktreePath)
    }
    return items
  }

  // Only the slice in view is rendered
  const items = useMemo(() => flatten((key) => expanded.has(key)), [trees, expanded, multipleWorktrees])
  // Arrow keys walk every match in tree order, opening collapsed groups as they reach them
  const { ordered, orderIndex } = useMemo(() => {
    const ordered = flatten(() => true).flatMap((item) => (item.type === 'row' ? [item.location] : []))
    return { ordered, orderIndex: new Map(ordered.map((location, position) => [location, position])) }
  }, [trees, multipleWorktrees])
  const keysOf = (location: SearchMatch): string[] => [
    `${location.worktreePath}\0`,
    ...ancestorFolders(location.path).map((folder) => `${location.worktreePath}\0${folder}/`),
    groupKey(location)
  ]
  /** Every folder and file key, for expanding everything at once */
  const allKeys = useMemo(() => new Set(locations.flatMap(keysOf)), [locations])
  const allExpanded = allKeys.size > 0 && [...allKeys].every((key) => expanded.has(key))

  const offsets = useMemo(() => {
    const tops = [0]
    for (const item of items) tops.push(tops[tops.length - 1] + (item.type === 'row' ? ROW_HEIGHT : GROUP_HEIGHT))
    return tops
  }, [items])
  const current = ordered[Math.min(index, ordered.length - 1)]
  const firstItem = Math.max(0, upperBound(offsets, scrollTop) - 1 - OVERSCAN)
  const lastItem = Math.min(items.length, upperBound(offsets, scrollTop + viewportHeight) + OVERSCAN)

  useEffect(() => {
    setIndex(0)
    if (listRef.current) listRef.current.scrollTop = 0
    setExpanded(new Set())
  }, [locations])

  // Reveal the current match: its folders and file open when arrows or a new search land on it
  useEffect(() => {
    if (!current) return
    setExpanded((previous) => (keysOf(current).every((key) => previous.has(key)) ? previous : new Set([...previous, ...keysOf(current)])))
  }, [current])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Only the top dialog reacts: a references lookup can open over search, and later dialogs come later in the DOM
      const dialogs = document.querySelectorAll('[data-locations-dialog]')
      if (dialogs[dialogs.length - 1] !== rootRef.current) return
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setIndex((value) => Math.max(0, Math.min(ordered.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
      else if (event.key === 'Enter' && current) onPick(current)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Keep the current row in view; it may not be rendered, so scroll by its computed offset
  useEffect(() => {
    const list = listRef.current
    const itemIndex = current ? items.findIndex((item) => item.type === 'row' && item.location === current) : -1
    if (!list || itemIndex === -1) return
    const top = offsets[itemIndex]
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight
  }, [index, items])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => setViewportHeight(list.clientHeight))
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={rootRef}
      data-locations-dialog
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[76vh] w-[1100px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/60 backdrop-blur-2xl"
      >
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-xs text-muted-foreground">
          {header}
          {locations.length > 0 && (
            <button
              title={allExpanded ? 'Collapse all' : 'Expand all'}
              aria-label={allExpanded ? 'Collapse all' : 'Expand all'}
              onClick={() => setExpanded(allExpanded ? new Set() : allKeys)}
              className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground"
            >
              <Icon name={allExpanded ? 'collapseAll' : 'expandAll'} className="size-3.5" />
            </button>
          )}
          <span className="shrink-0 text-[11px]">↑↓ to move · ↵ to open</span>
          <button onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent">
            <Icon name="close" className="size-3" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            className="w-[400px] shrink-0 overflow-y-auto border-r border-border px-1"
          >
            {locations.length === 0 && emptyText && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>}
            <div className="relative" style={{ height: offsets[items.length] }}>
              {items.slice(firstItem, lastItem).map((item, offset) => {
                const style = { position: 'absolute', top: offsets[firstItem + offset], left: 0, right: 0 } as const
                if (item.type === 'folder') {
                  const open = expanded.has(item.key)
                  return (
                    <button
                      key={item.key}
                      title={item.title}
                      style={{ ...style, paddingLeft: 6 + item.depth * 12 }}
                      onClick={() => setExpanded((previous) => toggleKey(previous, item.key))}
                      className="flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Icon name="chevron" className={`size-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
                      <Icon name="folder" className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="rounded-full bg-accent px-1.5 text-[10.5px] tabular-nums">{item.count}</span>
                    </button>
                  )
                }
                if (item.type === 'group') {
                  const open = expanded.has(item.key)
                  const { path } = item.inFile[0]
                  return (
                    <button
                      key={item.key}
                      title={path}
                      style={{ ...style, paddingLeft: 6 + item.depth * 12 }}
                      onClick={() => setExpanded((previous) => toggleKey(previous, item.key))}
                      className="flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-left text-xs hover:bg-accent"
                    >
                      <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
                      <FileIcon path={path} />
                      <span className="min-w-0 flex-1 truncate text-foreground/90">{path.split('/').pop()}</span>
                      <span className="rounded-full bg-accent px-1.5 text-[10.5px] text-muted-foreground tabular-nums">{item.inFile.length}</span>
                    </button>
                  )
                }
                const { location } = item
                const selected = location === current
                return (
                  <button
                    key={`${groupKey(location)}:${location.line}:${location.column}`}
                    style={{ ...style, paddingLeft: 10 + item.depth * 12 }}
                    onClick={() => setIndex(orderIndex.get(location) ?? 0)}
                    onDoubleClick={() => onPick(location)}
                    className={`flex h-6 items-center gap-2 rounded-md pr-2 text-left font-mono text-[11.5px] ${
                      selected ? 'bg-foreground/[.08] text-foreground' : 'text-foreground/75 hover:bg-accent'
                    }`}
                  >
                    <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">{location.line}</span>
                    <span className="truncate whitespace-pre">
                      <CodeLine text={location.text.trimStart()} path={location.path} matcher={matcher} />
                    </span>
                    {location.isDefinition && <span className="shrink-0 font-sans text-[10px] text-muted-foreground">definition</span>}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {current && (
              <>
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
                  <span className="min-w-0 truncate font-mono text-foreground/85">
                    {multipleWorktrees && <span className="text-muted-foreground">{baseName(current.worktreePath)}/</span>}
                    {current.path}
                    <span className="text-muted-foreground">:{current.line}</span>
                  </span>
                  <span className="flex-1" />
                  <button onClick={() => onPick(current)} className="h-6 shrink-0 rounded-md border border-border px-2 whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground">
                    Open file
                  </button>
                </div>
                {renderPreview(current)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Toggle({ label, title, on, onChange }: { label: string; title: string; on: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  return (
    <button
      title={title}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`grid h-6 min-w-6 place-items-center rounded px-1 font-mono text-[11px] ${on ? 'bg-foreground/[.12] text-foreground' : 'text-muted-foreground hover:bg-accent'}`}
    >
      {label}
    </button>
  )
}

/** ⇧⌘F: text search across every project in scope */
export function SearchDialog({
  worktreePaths,
  scopeLabel,
  renderPreview,
  onPick,
  onClose
}: {
  worktreePaths: string[]
  scopeLabel: string
  renderPreview: (location: SearchMatch) => React.JSX.Element
  onPick: (location: SearchMatch) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = usePersisted<string>(workspaceKey('search.query'), '')
  const [caseSensitive, setCaseSensitive] = usePersisted<boolean>(workspaceKey('search.caseSensitive'), false)
  const [wholeWord, setWholeWord] = usePersisted<boolean>(workspaceKey('search.wholeWord'), false)
  const [regex, setRegex] = usePersisted<boolean>(workspaceKey('search.regex'), false)
  const [result, setResult] = useState<SearchResult>({ matches: [], truncated: false })
  const [status, setStatus] = useState<'idle' | 'searching' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const options: SearchOptions = { caseSensitive, wholeWord, regex }
  const paths = worktreePaths.join('\n')

  useEffect(() => {
    if (!query) {
      setResult({ matches: [], truncated: false })
      return setStatus('idle')
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setStatus('searching')
      window.api.searchText(worktreePaths, query, options).then(
        (next) => {
          if (cancelled) return
          setResult(next)
          setError(null)
          setStatus('done')
        },
        (reason: unknown) => {
          if (cancelled) return
          setError(errorMessage(reason))
          setStatus('done')
        }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, caseSensitive, wholeWord, regex, paths])

  const matcher = matcherFor(query, options)
  const fileCount = new Set(result.matches.map(groupKey)).size

  return (
    <LocationsDialog
      locations={result.matches}
      emptyText={error ?? (status === 'done' ? 'No results' : status === 'searching' ? 'Searching...' : `Search ${scopeLabel}`)}
      matcher={matcher}
      renderPreview={renderPreview}
      onPick={onPick}
      onClose={onClose}
      header={
        <>
          <Icon name="search" className="size-3.5 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={(event) => event.target.select()}
            placeholder={`Search in ${scopeLabel}`}
            className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] tabular-nums">
            {status === 'searching'
              ? 'Searching...'
              : error
                ? <span className="text-red-400">Invalid pattern</span>
                : query && `${result.matches.length}${result.truncated ? '+' : ''} results in ${fileCount} files`}
          </span>
          <Toggle label="Aa" title="Match case" on={caseSensitive} onChange={setCaseSensitive} />
          <Toggle label="ab" title="Match whole word" on={wholeWord} onChange={setWholeWord} />
          <Toggle label=".*" title="Use regular expression" on={regex} onChange={setRegex} />
        </>
      }
    />
  )
}
