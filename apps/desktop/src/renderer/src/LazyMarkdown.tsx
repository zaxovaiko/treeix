import { lazy, Suspense } from 'react'
import type { ImageResolver } from './Markdown'

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })))

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
