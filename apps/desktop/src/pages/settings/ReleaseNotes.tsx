import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ShellView } from '../../shell/Shell'

/** The release's notes (GitHub markdown); links open in the browser */
export function ReleaseNotes({ view, notes }: { view: ShellView; notes: string }) {
  return (
    <div className="notes">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href && /^https?:/.test(href)) void view.api.openUrl(href)
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {notes}
      </Markdown>
    </div>
  )
}
