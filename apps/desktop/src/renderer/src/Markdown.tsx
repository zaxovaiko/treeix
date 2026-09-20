import { Children, createContext, useContext, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { NavigableCode } from './codeNavigation'
import { Icon } from './Icon'
import { MarkdownFoldsContext } from './LazyMarkdown'
import { Expandable } from './Lightbox'
import { remarkSections } from './markdownSections'
import { usePlugins } from './plugins'

// Headings become sections the reader can fold; the sanitizer has to let those through
const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'section'],
  attributes: { ...defaultSchema.attributes, section: ['dataLevel'] }
}

/** A heading with everything under it, folded away by clicking the heading */
function Section({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const foldAll = useContext(MarkdownFoldsContext)?.signal
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (foldAll) setOpen(foldAll.open)
  }, [foldAll?.at])
  const [heading, ...body] = Children.toArray(children).filter((child) => typeof child !== 'string' || child.trim() !== '')
  // The heading's own margins move to the section, so the arrow lines up with the heading text
  return (
    <section className="mt-[1.1em] mb-[0.5em] first:mt-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        // Clicking the heading folds it, but selecting its text still works: a drag is not a click
        onMouseDown={(event) => event.detail > 1 && event.preventDefault()}
        className="group/section flex w-full cursor-pointer items-center gap-1 text-left [&>div>:first-child]:my-0"
      >
        <Icon
          name="chevron"
          className={`size-3 shrink-0 translate-y-[3px] text-muted-foreground/50 group-hover/section:text-foreground ${open ? 'rotate-90' : ''}`}
        />
        <div className="min-w-0 flex-1">{heading}</div>
      </button>
      {open && <div className="pl-4">{body}</div>}
    </section>
  )
}

/** Starts dragging a column edge of the table around it; set by ResizableTable for its header cells */
const ColumnResize = createContext<((column: number, event: React.MouseEvent) => void) | null>(null)

/**
 * A table whose columns are sized by dragging the header edges. The first drag freezes the widths the browser
 * chose, so only the dragged column changes; double-clicking an edge goes back to automatic widths.
 */
function ResizableTable({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const table = useRef<HTMLTableElement>(null)
  const [widths, setWidths] = useState<number[] | null>(null)
  const startResize = (column: number, event: React.MouseEvent): void => {
    event.preventDefault()
    if (event.detail > 1) return setWidths(null)
    const header = table.current?.rows[0]
    if (!header) return
    const start = [...header.cells].map((cell) => cell.getBoundingClientRect().width)
    const from = event.clientX
    const move = (moved: MouseEvent): void => setWidths(start.map((width, index) => (index === column ? Math.max(40, width + moved.clientX - from) : width)))
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }
  return (
    <ColumnResize.Provider value={startResize}>
      <div className="overflow-x-auto">
      <table ref={table} style={widths ? { tableLayout: 'fixed', width: widths.reduce((sum, width) => sum + width, 0) } : undefined}>
        {widths && (
          <colgroup>
            {widths.map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
        )}
        {children}
      </table>
      </div>
    </ColumnResize.Provider>
  )
}

function ResizableHeader({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  const startResize = useContext(ColumnResize)
  return (
    <th {...props} className="relative">
      {children}
      {startResize && (
        <span
          title="Drag to resize, double-click to reset"
          onMouseDown={(event) => startResize(event.currentTarget.parentElement instanceof HTMLTableCellElement ? event.currentTarget.parentElement.cellIndex : 0, event)}
          className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-foreground/20"
        />
      )}
    </th>
  )
}

/** Loads images that need credentials the page doesn't have, e.g. Jira attachments; resolves to a data URL or rejects with the reason */
export type ImageResolver = (src: string) => Promise<string> | null

function ResolvedImage({ src, alt, resolve }: { src: string; alt: string; resolve: ImageResolver }): React.JSX.Element {
  const [state, setState] = useState<{ src: string } | { error: string } | null>(null)
  useEffect(() => {
    const pending = resolve(src)
    if (!pending) return setState({ src })
    let cancelled = false
    pending.then(
      (loaded) => !cancelled && setState({ src: loaded }),
      (reason: unknown) =>
        !cancelled &&
        setState({
          error: reason instanceof Error ? reason.message : String(reason)
        })
    )
    return () => {
      cancelled = true
    }
  }, [src])
  if (!state) return <span className="my-2 block h-24 rounded-lg bg-foreground/5" />
  if ('error' in state) {
    return (
      <span className="my-2 flex items-center gap-2 rounded-lg px-3 py-2 font-sans text-xs text-muted-foreground ring-1 ring-border">
        <span className="shrink-0 text-foreground/80">{alt || 'Image'}</span>
        <span className="min-w-0 break-words">{state.error}</span>
      </span>
    )
  }
  return (
    <Expandable title={alt} preview={<img src={state.src} alt={alt} className="my-2 max-w-full rounded-lg" />}>
      <img src={state.src} alt={alt} />
    </Expandable>
  )
}

const HEADING = /^#{1,6} \S/gm

export function Markdown({ children, baseUrl, resolveImage }: { children: string; baseUrl?: string; resolveImage?: ImageResolver }): React.JSX.Element {
  // One heading folds on its own; the scope's fold all button is for texts with a few of them
  const foldable = (children.match(HEADING) ?? []).length > 1
  const register = useContext(MarkdownFoldsContext)?.register
  useEffect(() => (foldable ? register?.() : undefined), [foldable, register])
  // Fenced blocks whose language a plugin renders, like mermaid diagrams
  const codeBlocks: Record<string, React.ComponentType<{ code: string }>> = Object.assign({}, ...usePlugins().loaded.map(({ plugin }) => plugin.codeBlocks ?? {}))
  return (
    <div className="markdown select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSections]}
        // Raw HTML from PR bodies (details, sub, img) is parsed, then sanitized to GitHub's allowlist
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
        urlTransform={(url) => defaultUrlTransform(baseUrl && url.startsWith('/') ? `${baseUrl}${url}` : url)}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          section: ({ node: _node, children }) => <Section>{children}</Section>,
          table: ({ node: _node, children }) => <ResizableTable>{children}</ResizableTable>,
          th: ({ node: _node, ...props }) => <ResizableHeader {...props} />,
          img: ({ node: _node, src, alt, ...props }) =>
            resolveImage && typeof src === 'string' ? (
              <ResolvedImage src={src} alt={alt ?? ''} resolve={resolveImage} />
            ) : (
              <Expandable title={alt} preview={<img src={src} alt={alt} {...props} />}>
                <img src={src} alt={alt} />
              </Expandable>
            ),
          code: ({ node: _node, className, children: code, ...props }) => {
            const Block = Object.hasOwn(codeBlocks, className?.replace(/^language-/, '') ?? '') ? codeBlocks[className?.replace(/^language-/, '') ?? ''] : undefined
            return Block ? (
              <Block code={String(code).trim()} />
            ) : (
              <NavigableCode className={className} {...props}>
                {code}
              </NavigableCode>
            )
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
