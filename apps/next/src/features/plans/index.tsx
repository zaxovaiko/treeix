import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PlanFile } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { addComment, clearComments, useComments, type ReviewComment } from '../../panes/file/comments'
import { CommentCard, CommentDraft } from '../../panes/file/CommentCards'
import { isChatLeaf, leafChat } from '../../panes/chat/open'
import { getChat, send } from '../../panes/chat/store'
import type { ShellView } from '../../shell/Shell'
import { leaves } from '../../shell/state'
import { leafPlan, rememberPlans } from './open'
// Comment cards and the crumb come from the file view's styles
import '../../styles/file.css'
import '../../styles/plan.css'

const Mermaid = lazy(() => import('../../lib/mermaid/Mermaid').then((m) => ({ default: m.Mermaid })))

/** What the pane needs to comment on a line: the line of each block comes from the markdown positions */
interface Lines {
  comments: ReviewComment[]
  open: number | null
  setOpen: (line: number | null) => void
  add: (line: number, text: string) => void
}
const LinesContext = createContext<Lines | null>(null)
/** Set inside a row, so nested blocks (a paragraph in a list item) stay part of it */
const InRow = createContext(false)

/** A line with a + gutter, its comments and the draft when open */
function Row({ line, label, as: Tag = 'div', children }: { line: number; label?: number; as?: 'div' | 'li'; children: ReactNode }) {
  const lines = useContext(LinesContext)
  if (!lines) return children
  const open = lines.open === line
  return (
    <Tag className={open ? 'prow on' : 'prow'}>
      <button className="pcg" title={`Comment on line ${line}`} onClick={() => lines.setOpen(open ? null : line)}>
        {label}
        <Icon name="plus" />
      </button>
      <InRow.Provider value={true}>{children}</InRow.Provider>
      {lines.comments
        .filter((comment) => comment.range.start === line)
        .map((comment) => (
          <CommentCard key={comment.id} comment={comment} />
        ))}
      {open && <CommentDraft label={`Comment on line ${line}`} onSave={(text) => lines.add(line, text)} onCancel={() => lines.setOpen(null)} />}
    </Tag>
  )
}

type BlockProps = { node?: ExtraProps['node']; children?: ReactNode }

/** Wraps a top-level block in a row on its first line; nested ones render as they are */
function block(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'table' | 'blockquote' | 'hr') {
  return function Block({ node, children }: BlockProps) {
    const nested = useContext(InRow)
    const inner = <Tag>{children}</Tag>
    const line = node?.position?.start.line
    return nested || !line ? inner : <Row line={line}>{inner}</Row>
  }
}

function ListItem({ node, children, className }: BlockProps & { className?: string }) {
  const nested = useContext(InRow)
  const line = node?.position?.start.line
  if (nested || !line) return <li className={className}>{children}</li>
  return (
    <Row as="li" line={line}>
      {children}
    </Row>
  )
}

const mermaidSource = (children: ReactNode): string | null => {
  const code = Array.isArray(children) ? children[0] : children
  if (typeof code !== 'object' || code === null || !('props' in code)) return null
  const props = code.props as { className?: unknown; children?: unknown }
  return props.className === 'language-mermaid' && typeof props.children === 'string' ? props.children : null
}

function Pre({ node, children }: BlockProps) {
  const nested = useContext(InRow)
  const diagram = mermaidSource(children)
  const inner = diagram ? (
    <Suspense fallback={<div className="mmdwait">Rendering diagram...</div>}>
      <Mermaid code={diagram} />
    </Suspense>
  ) : (
    <pre>{children}</pre>
  )
  const line = node?.position?.start.line
  return nested || !line ? inner : <Row line={line}>{inner}</Row>
}

const PARTS: Components = {
  h1: block('h1'),
  h2: block('h2'),
  h3: block('h3'),
  h4: block('h4'),
  h5: block('h5'),
  h6: block('h6'),
  p: block('p'),
  table: block('table'),
  blockquote: block('blockquote'),
  hr: block('hr'),
  li: ListItem,
  pre: Pre,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

/** The Claude in the same tab: a Claude chat, else a Claude terminal; null when there is none */
function claudeOf(view: ShellView, leaf: string): ((text: string) => void) | null {
  const tab = view.ui.tabs.find((t) => leaves(t.root).includes(leaf))
  const ids = tab ? leaves(tab.root) : []
  const chat = ids.find((id) => isChatLeaf(id) && getChat(leafChat(id)).info?.agent === 'claude')
  if (chat) return (text) => send(leafChat(chat), [{ type: 'text', text }])
  const terminal = ids.find((id) => view.sessions[id]?.kind === 'claude')
  if (!terminal) return null
  return (text) =>
    void view.api
      .write(terminal, `\x1b[200~${text}\x1b[201~`)
      .then(() => view.api.write(terminal, '\r'))
      .then(() => view.dispatch({ type: 'focus', session: terminal }))
}

/** Same prompt as the Electron plan view */
export const planPrompt = (path: string, comments: ReviewComment[]): string =>
  `Review comments on the plan ${path}. Update the plan to address each one:\n\n${comments.map((comment, index) => `${index + 1}. ${path}:${comment.range.start}\n${comment.text}`).join('\n\n')}\n`

/** Preview (markdown + mermaid) or Source, line comments, "Send to Claude" */
export function PlanPane({ view, leaf }: { view: ShellView; leaf: string }) {
  const name = leafPlan(leaf)
  const [plan, setPlan] = useState<PlanFile | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [source, setSource] = useState(false)
  const [open, setOpen] = useState<number | null>(null)

  const load = useCallback(() => {
    void view.api.plansList().then((list) => {
      rememberPlans(list)
      const found = list.find((p) => p.name === name) ?? null
      setPlan(found)
      if (!found) return setMissing(true)
      view.api.planRead(name).then(
        (markdown) => {
          setText(markdown)
          setMissing(false)
        },
        () => setMissing(true),
      )
    }, () => setMissing(true))
  }, [view.api, name])

  useEffect(() => {
    load()
    return view.api.watchPlace(`${view.home}/.claude/plans`, load)
  }, [view.api, view.home, load])

  const all = useComments()
  if (missing) return <div className="empty">This plan no longer exists.</div>
  if (!plan || text === null) return <div className="empty">Loading...</div>

  const comments = all.filter((comment) => comment.worktreePath === plan.path)
  const lines: Lines = {
    comments,
    open,
    setOpen,
    add: (line, note) => {
      addComment({ worktreePath: plan.path, filePath: plan.name, range: { start: line, end: line }, code: text.split('\n')[line - 1] ?? '', text: note })
      setOpen(null)
    },
  }
  const claude = claudeOf(view, leaf)
  const sendComments = () => {
    if (!claude) return
    claude(planPrompt(plan.path, comments))
    clearComments(plan.path)
  }

  return (
    <div className="plan">
      <div className="edcrumb">
        <Icon name="file" />
        <span className="mono">{plan.name}</span>
        <span className="dim trunc">· {plan.title}</span>
        <span className="grow" />
        <div className="seg">
          <button className={source ? '' : 'on'} onClick={() => setSource(false)}>Preview</button>
          <button className={source ? 'on' : ''} onClick={() => setSource(true)}>Source</button>
        </div>
      </div>
      <LinesContext.Provider value={lines}>
        <div className={source ? 'pdoc src' : 'pdoc'}>
          {source ? (
            text.split('\n').map((content, index) => (
              <Row key={index} line={index + 1} label={index + 1}>
                <span className="pline">{content || ' '}</span>
              </Row>
            ))
          ) : (
            <div className="pmd">
              <Markdown remarkPlugins={[remarkGfm]} components={PARTS}>
                {text}
              </Markdown>
            </div>
          )}
        </div>
      </LinesContext.Provider>
      {comments.length > 0 && (
        <div className="pcfoot">
          <span className="grow">
            {comments.length} comment{comments.length === 1 ? '' : 's'} on the plan
          </span>
          <button className="btn sm pri" disabled={!claude} title={claude ? undefined : 'No Claude in this tab'} onClick={sendComments}>
            <Icon name="claude" />
            Send to Claude
          </button>
        </div>
      )}
    </div>
  )
}
