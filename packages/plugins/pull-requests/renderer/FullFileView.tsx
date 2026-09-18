import { File, Virtualizer } from '@pierre/diffs/react'
import { useEffect, useState } from 'react'
import { codeThemeOptions, diffBackground } from '@treeix/app/FileView'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { EmptyState, errorMessage } from '@treeix/app/ui'

/** A whole file read-only, e.g. to see a pull request change in context; closes on Escape or a click outside */
export function FullFileView({ path, subtitle, load, onClose }: { path: string; subtitle: string; load: () => Promise<string | null>; onClose: () => void }): React.JSX.Element {
  const [contents, setContents] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    load().then(
      (text) => !cancelled && (text === null ? setError('This file is too large, binary or no longer exists') : setContents(text)),
      (reason: unknown) => !cancelled && setError(errorMessage(reason))
    )
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[6vh] backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[84vh] w-[1100px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/60 backdrop-blur-2xl"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-xs">
          <FileIcon path={path} />
          <span className="min-w-0 truncate font-mono text-foreground select-text">{path}</span>
          <span className="shrink-0 text-muted-foreground">{subtitle}</span>
          <span className="flex-1" />
          <button onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <Icon name="close" className="size-3" />
          </button>
        </div>
        {error ? (
          <EmptyState fill icon="alert" title={error} />
        ) : contents === null ? (
          <EmptyState fill title="Loading file..." />
        ) : (
          <Virtualizer className="min-h-0 flex-1 overflow-auto select-text">
            <File file={{ name: path, contents, cacheKey: `full:${path}:${contents.length}` }} className="block" style={diffBackground()} options={{ ...codeThemeOptions(), disableFileHeader: true }} />
          </Virtualizer>
        )}
      </div>
    </div>
  )
}
