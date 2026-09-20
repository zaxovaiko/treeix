import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { LazyMarkdown, MarkdownFoldButton } from './LazyMarkdown'
import { EmptyState, errorMessage, usePersisted } from './ui'

export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)

/** Remembered across files and restarts, so the preview stays on while moving between docs */
export const useMarkdownPreview = (): [boolean, (on: boolean) => void] => usePersisted<boolean>('markdown.preview', false)

/** Also holds the fold all button of the preview, which needs a MarkdownFoldScope around the header and the preview */
export function PreviewToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  return (
    <>
      {on && <MarkdownFoldButton />}
      <button
        title={on ? 'Show source' : 'Preview markdown'}
        aria-pressed={on}
        onClick={() => onChange(!on)}
        className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground ${on ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
      >
        <Icon name="eye" className="size-3.5" />
      </button>
    </>
  )
}

/** Rendered markdown of a file; `load` runs again whenever `loadKey` changes */
export function MarkdownPreview({ load, loadKey }: { load: () => Promise<string | null>; loadKey: string }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setText(null)
    setError(null)
    load().then(
      (content) => !cancelled && (content === null ? setError('This file is too large, binary or no longer exists') : setText(content)),
      (reason: unknown) => !cancelled && setError(errorMessage(reason))
    )
    return () => {
      cancelled = true
    }
  }, [loadKey])

  // Wide tables read better across the whole pane; remembered for every preview
  const [fullWidth, setFullWidth] = usePersisted<boolean>('markdown.fullWidth', false)
  if (error) return <EmptyState fill icon="alert" title={error} />
  if (text === null) return <EmptyState fill title="Loading preview..." />
  return (
    <div className="relative">
      <button
        title={fullWidth ? 'Readable width' : 'Full width'}
        onClick={() => setFullWidth(!fullWidth)}
        className="absolute top-3 right-3 z-10 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name={fullWidth ? 'narrow' : 'widen'} className="size-3.5" />
      </button>
      <div className={`mx-auto w-full px-8 py-6 ${fullWidth ? '' : 'max-w-3xl'}`}>
        <LazyMarkdown>{text}</LazyMarkdown>
      </div>
    </div>
  )
}
