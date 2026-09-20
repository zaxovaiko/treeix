import { createContext, lazy, Suspense, useCallback, useContext, useState } from 'react'
import type { ImageResolver } from './Markdown'
import { FoldAllButton } from './ui'

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })))

/** Fold all / unfold all for the sections of every markdown in a scope; `at` makes repeats take effect */
export type FoldSignal = { open: boolean; at: number }
type MarkdownFolds = { signal: FoldSignal | null; register: () => () => void; toggleAll: () => void; foldable: boolean }

export const MarkdownFoldsContext = createContext<MarkdownFolds | null>(null)

/** Wraps a page whose header holds a MarkdownFoldButton for the markdown rendered below it */
export function MarkdownFoldScope({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [signal, setSignal] = useState<FoldSignal | null>(null)
  // Markdowns with a few headings count themselves in; one heading folds on its own
  const [foldableCount, setFoldableCount] = useState(0)
  const register = useCallback(() => {
    setFoldableCount((count) => count + 1)
    return () => setFoldableCount((count) => count - 1)
  }, [])
  const toggleAll = (): void => setSignal({ open: !(signal?.open ?? true), at: Date.now() })
  return <MarkdownFoldsContext.Provider value={{ signal, register, toggleAll, foldable: foldableCount > 0 }}>{children}</MarkdownFoldsContext.Provider>
}

export function MarkdownFoldButton(): React.JSX.Element | null {
  const folds = useContext(MarkdownFoldsContext)
  if (!folds?.foldable) return null
  return <FoldAllButton anyOpen={folds.signal?.open ?? true} groups="sections" shortcut={null} onClick={folds.toggleAll} />
}

/** Markdown pulls in remark, rehype and a sanitizer, so load it the first time something needs rendering */
export function LazyMarkdown({ children, baseUrl, resolveImage }: { children: string; baseUrl?: string; resolveImage?: ImageResolver }): React.JSX.Element {
  return (
    <Suspense fallback={<p className="text-[13px] whitespace-pre-wrap text-foreground/85">{children}</p>}>
      <Markdown baseUrl={baseUrl} resolveImage={resolveImage}>
        {children}
      </Markdown>
    </Suspense>
  )
}
