import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ISearchDecorationOptions, ISearchOptions, ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search'
import type { SessionStatus } from '../../ipc/api'
import { Icon } from '../../lib/icons'

/** "Find in pane" from the prototype: Enter and Shift+Enter step, Esc closes */
export function FindBar({ search, decorations, signal, onClose }: { search: SearchAddon; decorations(): ISearchDecorationOptions; signal: number; onClose(): void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<ISearchResultChangeEvent | null>(null)

  useEffect(() => inputRef.current?.select(), [signal])
  useEffect(() => {
    const sub = search.onDidChangeResults(setResults)
    return () => sub.dispose()
  }, [search])

  const step = (forward: boolean, incremental = false): void => {
    if (!query) return
    const options: ISearchOptions = { caseSensitive, regex, incremental, decorations: decorations() }
    try {
      if (forward) search.findNext(query, options)
      else search.findPrevious(query, options)
    } catch {
      // A regex still being typed
      setResults({ resultIndex: -1, resultCount: 0 })
    }
  }

  useEffect(() => {
    if (query) step(true, true)
    else {
      search.clearDecorations()
      setResults(null)
    }
  }, [search, query, caseSensitive, regex])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') step(!e.shiftKey)
    else if (e.key === 'Escape') onClose()
    else return
    e.preventDefault()
  }

  const count = !query || !results ? '' : results.resultCount ? `${results.resultIndex + 1} of ${results.resultCount}` : 'No results'
  return (
    <div className="tfind" onMouseDown={(e) => e.stopPropagation()}>
      <Icon name="search" />
      <input ref={inputRef} autoFocus placeholder="Find in pane" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
      <span className="dim count">{count}</span>
      <button className={`tog ${caseSensitive ? 'on' : ''}`} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case">
        Aa
      </button>
      <button className={`tog ${regex ? 'on' : ''}`} onClick={() => setRegex(!regex)} title="Regex">
        .*
      </button>
      <button className="icon sm up" onClick={() => step(false)} title="Previous (⇧⏎)">
        <Icon name="down" />
      </button>
      <button className="icon sm" onClick={() => step(true)} title="Next (⏎)">
        <Icon name="down" />
      </button>
      <button className="icon sm" onClick={onClose} title="Close (esc)">
        <Icon name="x" />
      </button>
    </div>
  )
}

function sessionNote(status: SessionStatus, exitCode: number | null): string {
  if (status === 'restored') return 'Restored after the terminal host restarted. The process ended; its scrollback is kept.'
  if (status === 'crashed') return 'The terminal host crashed. The scrollback is from its last snapshot.'
  return exitCode ? `Exited with code ${exitCode}` : 'Process exited'
}

/** Over the bottom of a pane whose process is gone: exited and kept, restored after a daemon restart, or crashed */
export function SessionBar({ status, exitCode, onRestart, onClose }: { status: SessionStatus; exitCode: number | null; onRestart(): void; onClose(): void }) {
  return (
    <div className={`tbar ${status}`} role="status">
      <Icon name={status === 'crashed' ? 'alert' : status === 'restored' ? 'host' : 'terminal'} />
      <span className="grow">
        {sessionNote(status, exitCode)}
        <span className="dim"> · Enter restarts it here</span>
      </span>
      <button className="tbtn pri" onClick={onRestart}>
        Restart
      </button>
      <button className="tbtn" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
