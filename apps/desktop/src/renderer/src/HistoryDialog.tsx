import { MultiFileDiff } from '@pierre/diffs/react'
import { useEffect, useState } from 'react'
import type { HistoryEntry } from '../../shared/types'
import { codeThemeOptions, diffBackground } from './FileView'
import { Icon } from './Icon'
import { baseName } from './Sidebar'
import { EmptyState, errorMessage } from './ui'

const timeLabel = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Local snapshots taken before autosave overwrote the file, diffed against what is on disk now */
export function HistoryDialog({
  worktreePath,
  path,
  onRestored,
  onClose
}: {
  worktreePath: string
  path: string
  onRestored: () => void
  onClose: () => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.listHistory(worktreePath, path).then((list) => {
      setEntries(list)
      setSelected(list[0]?.id ?? null)
    }, (reason: unknown) => setError(errorMessage(reason)))
    window.api.readFile(worktreePath, path).then((text) => setCurrent(text ?? ''), () => setCurrent(''))
  }, [worktreePath, path])

  useEffect(() => {
    setSnapshot(null)
    if (selected) window.api.readHistory(worktreePath, path, selected).then(setSnapshot, (reason: unknown) => setError(errorMessage(reason)))
  }, [selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const restore = (): void => {
    if (snapshot === null || !window.confirm(`Restore ${baseName(path)} to this version? The current version is kept in history.`)) return
    window.api.saveFile(worktreePath, path, snapshot, null).then(() => {
      onRestored()
      onClose()
    }, (reason: unknown) => setError(errorMessage(reason)))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh] backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[76vh] w-[1100px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/60 backdrop-blur-2xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-xs text-muted-foreground">
          <span>
            Edit history of <span className="font-mono text-foreground">{path}</span>
          </span>
          <span className="flex-1" />
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={restore}
            disabled={snapshot === null}
            className="h-6 rounded-md bg-primary px-2.5 font-medium text-white disabled:opacity-40"
          >
            Restore this version
          </button>
          <button onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md hover:bg-accent">
            <Icon name="close" className="size-3" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-60 shrink-0 overflow-y-auto border-r border-border p-1">
            {entries?.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No earlier versions yet. Snapshots are taken while you edit here, at most one a minute.</p>}
            {entries?.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setSelected(entry.id)}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] ${
                  entry.id === selected ? 'bg-primary/20 text-foreground' : 'text-foreground/75 hover:bg-accent'
                }`}
              >
                <span className="flex-1">{timeLabel(entry.savedAt)}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{(entry.bytes / 1024).toFixed(1)} KB</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {snapshot === null || current === null ? (
              <EmptyState fill title={entries === null || selected ? 'Loading...' : 'Pick a version'} />
            ) : snapshot === current ? (
              <EmptyState fill title="Same as the current file" />
            ) : (
              <MultiFileDiff
                oldFile={{ name: path, contents: snapshot, cacheKey: `history:${worktreePath}:${path}:${selected}` }}
                newFile={{ name: path, contents: current, cacheKey: `history-current:${worktreePath}:${path}:${current.length}` }}
                className="block"
                style={diffBackground()}
                options={{ ...codeThemeOptions(), diffStyle: 'unified' }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
