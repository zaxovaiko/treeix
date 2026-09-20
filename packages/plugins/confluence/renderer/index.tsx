import { defineActions, key } from '@treeix/shared/keymap'
import { lazy, Suspense, useState } from 'react'
import { ApiToken } from '@treeix/atlassian/renderer/ApiToken'
import { type RendererPlugin, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown, MarkdownFoldButton, MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import type { Page } from '../shared/types'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { confluenceApi, confluenceBridge, openRequest, pageCache, pageOfUrl, resolveImage, TAB_ID, TTL } from './api'

// The tab pulls in the page view, search and tree, so it loads when first opened
const ConfluenceTab = lazy(() => import('./ConfluenceTab').then((module) => ({ default: module.ConfluenceTab })))

function Tab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <ConfluenceTab />
    </Suspense>
  )
}

/** A linked page: expands in place, or opens in the Confluence tab */
function PagePreview({ url }: { url: string }): React.JSX.Element {
  const host = useHost()
  const link = pageOfUrl(url)
  const id = link?.id ?? ''
  const [open, setOpen] = useState(false)
  // Nothing is fetched until the preview is expanded, but a cached page shows at once
  const { value: page, error } = useCached<Page>(pageCache, open ? id : '', TTL.page, confluenceApi.page)
  return (
    <MarkdownFoldScope>
      <div className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground">
          <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
          <Icon name="file" className="size-3.5 shrink-0 text-sky-400" />
          <span className="truncate">{page?.title ?? link?.title ?? `Page ${id}`}</span>
        </button>
        {open && <MarkdownFoldButton />}
        <button
          title="Open in the Confluence tab"
          onClick={() => {
            openRequest.update({ id })
            host.setActiveTab(TAB_ID)
          }}
          className="h-6 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Open
        </button>
        <a href={url} target="_blank" rel="noreferrer" title="Open in Confluence" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <Icon name="external" className="size-3" />
        </a>
      </div>
      {open && (
        <div className="max-h-[70vh] overflow-y-auto border-t border-border px-5 py-3">
          {error && <p className="text-xs text-red-400 select-text">{error}</p>}
          {!page && !error && <p className="text-xs text-muted-foreground">Loading page...</p>}
          {page && <Markdown resolveImage={resolveImage}>{page.body}</Markdown>}
        </div>
      )}
    </MarkdownFoldScope>
  )
}

defineActions([
  { id: 'confluence.search', label: 'Search, or paste a page link', section: 'Confluence', page: TAB_ID, keys: key('Slash') },
  { id: 'confluence.agentComments', label: 'Add the page to agent comments', section: 'Confluence', page: TAB_ID, keys: key('KeyA') },
  { id: 'confluence.open', label: 'Open in Confluence', section: 'Confluence', page: TAB_ID, keys: key('KeyO') },
  { id: 'confluence.copyLink', label: 'Copy link', section: 'Confluence', page: TAB_ID, keys: key('KeyY') },
  { id: 'confluence.reload', label: 'Reload the page', section: 'Confluence', page: TAB_ID, keys: key('KeyR') },
  { id: 'confluence.fold', label: 'Fold or unfold all spaces', section: 'Confluence', page: TAB_ID, keys: key('KeyZ') }
])

const plugin: RendererPlugin = {
  shortcuts: [{ keys: '← →', label: 'Fold / unfold the space', section: 'Confluence', page: TAB_ID }],
  tabs: [{ id: TAB_ID, label: 'Confluence', icon: 'bookOpen', order: 50, render: Tab, panels: ['terminal'] }],
  Settings: () => <ApiToken bridge={confluenceBridge} purpose="Search, recently viewed pages and images" />,
  linkPreviews: [{ label: 'Confluence', keyOf: (url) => pageOfUrl(url)?.id ?? null, render: PagePreview }]
}

export default plugin
