import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { LazyMarkdown, MarkdownFoldButton } from './LazyMarkdown'
import { EmptyState, errorMessage, usePersisted } from './ui'

export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)
export const isHtmlPath = (path: string): boolean => /\.html?$/i.test(path)
/** Files with a rendered view beside their source */
export const isPreviewPath = (path: string): boolean => isMarkdownPath(path) || isHtmlPath(path)

/** Remembered across files and restarts, so the preview stays on while moving between docs */
export const useMarkdownPreview = (): [boolean, (on: boolean) => void] => usePersisted<boolean>('markdown.preview', false)

/** Also holds the fold all button of the preview, which needs a MarkdownFoldScope around the header and the preview */
export function PreviewToggle({ path, on, onChange }: { path: string; on: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  const html = isHtmlPath(path)
  return (
    <>
      {on && !html && <MarkdownFoldButton />}
      <button
        title={on ? 'Show source' : html ? 'Preview page' : 'Preview markdown'}
        aria-pressed={on}
        onClick={() => onChange(!on)}
        className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground ${on ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
      >
        <Icon name="eye" className="size-3.5" />
      </button>
    </>
  )
}

/**
 * A local HTML file as a page, in a webview hardened like the built-in browser's: its scripts run and its relative CSS and images load, while none of it reaches the app.
 * `reloadKey` reloads it, so saves show up
 */
export function HtmlPreview({ path, reloadKey }: { path: string; reloadKey: string }): React.JSX.Element {
  const url = `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`
  return <webview key={reloadKey} src={url} className="min-h-0 w-full flex-1 bg-white" />
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
