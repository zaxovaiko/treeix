import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SearchMatch, SearchOptions, SearchResult } from '../ipc/api'
import { Icon } from '../lib/icons'
import { IS_MAC } from '../shell/shortcuts'
import type { ShellView } from '../shell/Shell'
import { Glyph } from './icons'
import { Modal } from './index'
import { baseName, dirName, groupMatches, splitMatch } from './logic'

const PER_FILE = 8
const DEBOUNCE_MS = 200
const TOGGLES: [keyof SearchOptions, string, string][] = [
  ['caseSensitive', 'Aa', 'Match case'],
  ['wholeWord', 'ab', 'Whole word'],
  ['regex', '.*', 'Regular expression'],
]

/** Searches the active place; a hit opens the file at its line */
export function FindInFiles({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const place = view.activeTab && view.placeOfTab(view.activeTab)
  const root = place && place.kind !== 'scratch' && !place.missing ? place.path : null
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!root || !query) return setResult(null)
    let stale = false
    const timer = setTimeout(
      () =>
        void view.api.searchText([root], query, options).then(
          (r) => {
            if (stale) return
            setResult(r)
            setError(null)
            setSelected(0)
          },
          (e: unknown) => {
            if (stale) return
            setResult(null)
            setError(e instanceof Error ? e.message : String(e))
          }
        ),
      DEBOUNCE_MS
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [view.api, root, query, options])

  const groups = result && query ? groupMatches(result.matches) : []
  const visible = groups.flatMap((g) => (expanded.has(g.path) ? g.matches : g.matches.slice(0, PER_FILE)))
  const current = Math.min(selected, visible.length - 1)

  useEffect(() => list.current?.querySelector('.ffrow.on')?.scrollIntoView({ block: 'nearest' }), [current])

  const open = (m: SearchMatch | undefined) => {
    if (!m) return
    onClose()
    view.openFile(m.root, m.path, m.line, m.column)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') open(visible[current])
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && visible.length) setSelected((current + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length)
    else return
    e.preventDefault()
  }

  const files = groups.length
  const hits = result?.matches.length ?? 0
  let index = -1
  return (
    <Modal className="ff" onClose={onClose}>
      <div className="ffq">
        <Icon name="search" />
        <input autoFocus value={query} placeholder={root ? `Find in ${place?.name}` : 'Find in files'} spellCheck={false} disabled={!root} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        {TOGGLES.map(([key, label, title]) => (
          <button key={key} className={`tog ${options[key] ? 'on' : ''}`} title={title} aria-pressed={options[key]} onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}>
            {label}
          </button>
        ))}
      </div>
      <div className="ffres" ref={list}>
        {!root ? (
          <div className="empty">Open a folder to search its files</div>
        ) : error && query ? (
          <div className="empty err">{error}</div>
        ) : !query ? (
          <div className="empty">Type to search the files of this place</div>
        ) : result && !hits ? (
          <div className="empty">No results</div>
        ) : (
          groups.map((g) => {
            const more = g.matches.length - PER_FILE
            const shown = expanded.has(g.path) ? g.matches : g.matches.slice(0, PER_FILE)
            return (
              <div key={g.path}>
                <div className="ffh">
                  <Glyph name="file" />
                  <b>{baseName(g.path)}</b>
                  <span className="dim trunc">{dirName(g.path)}</span>
                  <span className="grow" />
                  <span className="num dim">{g.matches.length}</span>
                </div>
                {shown.map((m) => {
                  const i = ++index
                  const [before, hit, after] = splitMatch(m)
                  return (
                    <button key={`${m.line}:${m.column}`} className={`ffrow ${i === current ? 'on' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => open(m)}>
                      <span className="num dim">{m.line}</span>
                      <span className="mono trunc">
                        {before.trimStart()}
                        <mark>{hit}</mark>
                        {after}
                      </span>
                    </button>
                  )
                })}
                {more > 0 && !expanded.has(g.path) && (
                  <button className="ffrow more" onClick={() => setExpanded((all) => new Set(all).add(g.path))}>
                    {more} more in {baseName(g.path)}
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="mft">
        <span className="dim">
          {hits} result{hits === 1 ? '' : 's'} in {files} file{files === 1 ? '' : 's'}
          {result?.truncated && ': showing the first ones, narrow the search'}
        </span>
        <kbd>{IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'}</kbd>
      </div>
    </Modal>
  )
}
