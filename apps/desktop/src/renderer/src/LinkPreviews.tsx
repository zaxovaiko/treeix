import type { LinkPreview } from '@treeix/sdk'
import { ErrorBoundary } from './ErrorBoundary'
import { usePlugins } from './plugins'

/** Previews for links in a text, grouped by the plugin preview that recognises them; nothing when none does */
export function LinkPreviews({ urls, exclude = [] }: { urls: string[]; exclude?: string[] }): React.JSX.Element | null {
  const previews = usePlugins().loaded.flatMap(({ plugin }) => plugin.linkPreviews ?? [])
  const groups = previews
    .map((preview): { preview: LinkPreview; links: { key: string; url: string }[] } => {
      const links = new Map<string, string>()
      for (const url of urls) {
        const key = preview.keyOf(url)
        if (key && !exclude.includes(key) && !links.has(key)) links.set(key, url)
      }
      return { preview, links: [...links].map(([key, url]) => ({ key, url })) }
    })
    .filter((group) => group.links.length > 0)
  if (groups.length === 0) return null
  return (
    <>
      {groups.map(({ preview, links }) => (
        <section key={preview.label} className="mt-4 rounded-xl border border-border">
          <h3 className="flex items-center border-b border-border px-4 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {preview.label} <span className="ml-1.5 font-normal">{links.length}</span>
          </h3>
          {links.map(({ key, url }) => (
            <div key={key} className="border-b border-border last:border-b-0">
              <ErrorBoundary label={preview.label} resetKey={url}>
                <preview.render url={url} />
              </ErrorBoundary>
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
