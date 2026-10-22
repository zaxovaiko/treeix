import { Fragment, memo, useEffect, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { PermissionOption, ToolCall, ToolOutput } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { IS_MAC } from '../../shell/shortcuts'
import { useMode } from '../file/mode'
import { parseShellPrompt } from './composer'
import { type Block, diffCounts, fileTarget, type PendingPermission, recomputeWaiting, turnChanges, turnsOf } from './feed'
import { ChatIcon } from './icons'

type Diff = Extract<ToolOutput, { type: 'diff' }>
type Image = { mimeType: string; data: string }

/** What blocks need from the pane: where paths resolve, and the way out to files and links */
export interface BlockHost {
  cwd: string
  showThinking: boolean
  openFile: (root: string, file: string, line?: number) => void
  openUrl: (url: string) => void
}

const COLLAPSED_LINES = 10
export const PRIMARY = IS_MAC ? '⌘' : 'Ctrl+'

/** Agents wrap command output in a ```console fence, which shows as text in a plain block */
const unfenced = (text: string): string => text.replace(/^```[\w-]*\n([\s\S]*?)(?:\n?```\s*)?$/, '$1')

const texts = (call: ToolCall): string =>
  call.output
    .map((output) => (output.type === 'text' ? unfenced(output.text) : ''))
    .filter(Boolean)
    .join('\n')

/** Why a call failed, as the agent told the model; Claude Code wraps it in <tool_use_error> */
const failureOf = (call: ToolCall): string => (call.status === 'failed' ? texts(call).replace(/<\/?tool_use_error>/g, '').trim() : '')

const diffs = (call: ToolCall): Diff[] => call.output.filter((output): output is Diff => output.type === 'diff')

export const firstAllow = (options: PermissionOption[]) => options.find((option) => option.kind.startsWith('allow'))
export const firstReject = (options: PermissionOption[]) => options.find((option) => option.kind.startsWith('reject'))

/** Seconds since `from`, ticking while `live` */
export function useElapsed(from: number | null, live: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return from === null ? 0 : Math.max(0, Math.floor((now - from) / 1000))
}

export const formatElapsed = (seconds: number): string => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`)

export const imageSrc = (image: Image) => `data:${image.mimeType};base64,${image.data}`

const Images = ({ images }: { images: Image[] }) =>
  images.length === 0 ? null : (
    <div className="cimgs">
      {images.map((image, index) => (
        <img key={index} src={imageSrc(image)} alt="" />
      ))}
    </div>
  )

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function Location({ host, path, line }: { host: BlockHost; path: string; line: number | null }) {
  const shown = path.startsWith(`${host.cwd}/`) ? path.slice(host.cwd.length + 1) : path
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    const target = fileTarget(host.cwd, path)
    host.openFile(target.root, target.path, line ?? undefined)
  }
  return (
    <button className="cloc mono trunc" onClick={open} title={path}>
      {shown}
      {line !== null && `:${line}`}
    </button>
  )
}

/** Agent text can name any image URL, and loading it would leak to that server; only data: images show */
function markdownParts(host: BlockHost): Components {
  return {
    img: ({ src, alt }) => (typeof src === 'string' && src.startsWith('data:') ? <img src={src} alt={alt ?? ''} /> : <span className="dim">[{alt || 'image'}]</span>),
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href && /^https?:/.test(href)) host.openUrl(href)
        }}
      >
        {children}
      </a>
    ),
  }
}

/** The agent's reply as markdown, or as the source it wrote */
function AgentText({ host, text, images }: { host: BlockHost; text: string; images: Image[] }) {
  const [raw, setRaw] = useState(false)
  return (
    <div className="cmsg a">
      <Images images={images} />
      {text && (
        <>
          <button className="craw" onClick={() => setRaw(!raw)} aria-pressed={raw} title={raw ? 'Show formatted' : 'Show markdown source'}>
            <ChatIcon name={raw ? 'eye' : 'code'} />
            {raw ? 'Preview' : 'Raw'}
          </button>
          {raw ? (
            <pre className="mono">{text}</pre>
          ) : (
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={markdownParts(host)}>
                {text}
              </Markdown>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TextBlock({ host, block }: { host: BlockHost; block: Extract<Block, { type: 'text' }> }) {
  if (block.role === 'agent') return <AgentText host={host} text={block.text} images={block.images} />
  const shell = parseShellPrompt(block.text)
  if (shell)
    return (
      <div className="cmsg u mono">
        <div>
          <span className="dim">! </span>
          {shell.command}
        </div>
        {shell.output && <pre className="dim">{shell.output}</pre>}
      </div>
    )
  return (
    <div className="cmsg u">
      <Images images={block.images} />
      {block.text}
    </div>
  )
}

function ThoughtBlock({ host, block }: { host: BlockHost; block: Extract<Block, { type: 'thought' }> }) {
  const [open, setOpen] = useState(false)
  const running = block.endedAt === null
  const elapsed = useElapsed(block.startedAt, running)
  if (!host.showThinking) return null
  const seconds = block.endedAt === null ? elapsed : Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000))
  return (
    <div className="cthink">
      <button onClick={() => setOpen(!open)}>
        <ChatIcon name="sparkles" />
        {running ? `Thinking ${formatElapsed(seconds)}` : `Thought for ${formatElapsed(seconds)}`}
      </button>
      {(open || running) && <div className="cthought">{block.text}</div>}
    </div>
  )
}

const StatusIcon = ({ status }: { status: ToolCall['status'] }) =>
  status === 'completed' ? <ChatIcon name="check" className="ok" /> : status === 'failed' ? <Icon name="alert" className="bad" /> : <i className="cdot" />

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className="ccounts mono">
    <span className="add">+{added}</span> <span className="del">-{removed}</span>
  </span>
)

function DiffView({ diff }: { diff: Diff }) {
  const mode = useMode()
  return (
    <MultiFileDiff
      oldFile={{ name: diff.path, contents: diff.oldText ?? '' }}
      newFile={{ name: diff.path, contents: diff.newText }}
      disableWorkerPool
      options={{ theme: { dark: 'pierre-dark', light: 'pierre-light' }, themeType: mode, diffStyle: 'unified', disableFileHeader: true }}
    />
  )
}

function Output({ text, collapseAfter }: { text: string; collapseAfter: number | null }) {
  const [full, setFull] = useState(false)
  const lines = text.split('\n')
  const cut = collapseAfter !== null && !full && lines.length > collapseAfter
  return (
    <div className="cout">
      <pre className="mono">{cut ? lines.slice(0, collapseAfter).join('\n') : text}</pre>
      {cut && (
        <button className="dim" onClick={() => setFull(true)}>
          Show {lines.length - collapseAfter} more lines
        </button>
      )}
    </div>
  )
}

/** A tool call row: status, name, where; clicking unfolds its output or diffs */
function ToolCard({ host, call, asking = false, children }: { host: BlockHost; call: ToolCall; asking?: boolean; children?: ReactNode }) {
  const [unfolded, setOpen] = useState(false)
  // A call waiting for permission shows what it would do
  const open = unfolded || asking
  const output = texts(call)
  const location = call.locations[0]
  const changes = diffs(call)
  const isEdit = call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move'
  const isLookup = call.kind === 'read' || call.kind === 'search' || call.kind === 'fetch'
  const failure = failureOf(call)
  const details = failure || (isEdit ? '' : output || (isLookup || call.kind === 'execute' ? '' : JSON.stringify(call.rawInput, null, 2) || ''))
  const expandable = details !== '' || (isEdit && changes.length > 0)
  const total = changes.reduce(
    (sum, diff) => {
      const counts = diffCounts(diff.oldText, diff.newText)
      return { added: sum.added + counts.added, removed: sum.removed + counts.removed }
    },
    { added: 0, removed: 0 },
  )
  const summary = !isEdit && !location && !open ? output.split('\n')[0] : ''
  return (
    <div className={`ctool ${open ? 'open' : ''} ${children ? 'nest' : ''}`}>
      <div className={`crow ${expandable ? 'click' : ''}`} onClick={expandable ? () => setOpen(!open) : undefined}>
        <StatusIcon status={call.status} />
        <b className={`trunc ${call.kind === 'execute' ? 'mono' : ''}`}>{call.title}</b>
        {location && !isEdit && <Location host={host} path={location.path} line={location.line} />}
        {isEdit && changes[0] && <span className="dim trunc">{baseName(changes[0].path)}</span>}
        {summary && <span className="dim trunc">{summary}</span>}
        <span className="grow" />
        {changes.length > 0 && <Counts {...total} />}
        {expandable && <Icon name="right" className={`chev ${open ? 'down' : ''}`} />}
      </div>
      {failure && !open && <div className="cfail trunc">{failure.split('\n')[0]}</div>}
      {isEdit &&
        open &&
        changes.map((diff) => (
          <div key={diff.path} className="cdiff">
            <div className="crow">
              <Location host={host} path={diff.path} line={null} />
              <span className="grow" />
              <Counts {...diffCounts(diff.oldText, diff.newText)} />
            </div>
            <DiffView diff={diff} />
          </div>
        ))}
      {open && details !== '' && <Output text={details} collapseAfter={call.kind === 'execute' ? COLLAPSED_LINES : null} />}
      {children}
    </div>
  )
}

/** The prototype's ask box: numbered options, the first allow marked; keys answer the newest one */
function PermissionCard({ permission, newest, onAnswer }: { permission: PendingPermission; newest: boolean; onAnswer: (optionId: string) => void }) {
  const allow = firstAllow(permission.options)
  const reject = firstReject(permission.options)
  return (
    <div className="ask" role="group" aria-label={permission.title}>
      <b>{permission.title}</b>
      {permission.options.map((option, index) => (
        <button key={option.id} className={`opt ${option === allow ? 'sel' : ''}`} onClick={() => onAnswer(option.id)}>
          <span className="mark">{option === allow ? '❯' : ''}</span>
          {index + 1}. {option.name}
          {newest && option === allow && <kbd>{PRIMARY}↵</kbd>}
          {newest && option === reject && <kbd>Esc</kbd>}
        </button>
      ))}
    </div>
  )
}

const ErrorBlock = ({ message }: { message: string }) => (
  <div className="cerr">
    <Icon name="alert" />
    <span className="grow">{message}</span>
  </div>
)

export const pendingOf = (block: Block): PendingPermission | null => (block.type === 'permission' ? block.permission : block.type === 'tool' ? block.permission : null)

type FeedProps = {
  host: BlockHost
  blocks: Block[]
  /** The permission keyboard answers go to */
  newest: PendingPermission | null
  onAnswer: (requestId: string, optionId: string) => void
}

function FeedBlocks({ host, blocks, newest, onAnswer }: FeedProps) {
  const card = (permission: PendingPermission) => (
    <PermissionCard key={permission.requestId} permission={permission} newest={permission === newest} onAnswer={(optionId) => onAnswer(permission.requestId, optionId)} />
  )
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <TextBlock key={index} host={host} block={block} />
          case 'thought':
            return <ThoughtBlock key={index} host={host} block={block} />
          case 'tool':
            return block.children.length > 0 || block.permission ? (
              <ToolCard key={block.call.id} host={host} call={block.call} asking={block.permission !== null}>
                {block.children.length > 0 && <SubagentLog host={host} blocks={block.children} newest={newest} onAnswer={onAnswer} />}
                {block.permission && card(block.permission)}
              </ToolCard>
            ) : (
              <ToolCard key={block.call.id} host={host} call={block.call} />
            )
          case 'permission':
            return card(block.permission)
          case 'error':
            return <ErrorBlock key={index} message={block.message} />
        }
      })}
    </>
  )
}

/** What a subagent said and ran, folded under the call that started it */
function SubagentLog(props: FeedProps) {
  const [open, setOpen] = useState(false)
  // A subagent asking for permission unfolds, so the card is never hidden
  const shown = open || recomputeWaiting(props.blocks)
  const steps = props.blocks.filter((block) => block.type === 'tool').length
  return (
    <div className="csub">
      <button className="csteps" onClick={() => setOpen(!open)}>
        <Icon name="right" className={`chev ${shown ? 'down' : ''}`} />
        Subagent · {steps} {steps === 1 ? 'step' : 'steps'}
      </button>
      {shown && (
        <div className="cin">
          <FeedBlocks {...props} />
        </div>
      )}
    </div>
  )
}

/** A finished turn's tool calls and thoughts, folded behind one row so its reply reads on its own */
function Steps(props: FeedProps) {
  const [open, setOpen] = useState(false)
  const shown = open || recomputeWaiting(props.blocks)
  const count = props.blocks.filter((block) => block.type === 'tool').length
  return (
    <>
      <button className="csteps" onClick={() => setOpen(!open)}>
        <Icon name="right" className={`chev ${shown ? 'down' : ''}`} />
        {count} {count === 1 ? 'step' : 'steps'}
      </button>
      {shown && <FeedBlocks {...props} />}
    </>
  )
}

/** The files a finished turn changed, so its edits read without unfolding its steps */
function ChangeSummary({ host, blocks }: { host: BlockHost; blocks: Block[] }) {
  const files = turnChanges(blocks)
  if (!files.length) return null
  const total = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 })
  return (
    <div className="cchanges">
      <div className="crow">
        <span className="grow dim">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <Counts {...total} />
      </div>
      {files.map((file) => (
        <div key={file.path} className="crow">
          <Location host={host} path={file.path} line={null} />
          <span className="grow" />
          <Counts {...file} />
        </div>
      ))}
    </div>
  )
}

/** The feed turn by turn; every turn but the one still running folds its steps */
export const TurnBlocks = memo(function TurnBlocks({ live, ...props }: FeedProps & { live: boolean }) {
  const turns = turnsOf(props.blocks)
  return (
    <>
      {turns.map((turn, index) =>
        (live && index === turns.length - 1) || !turn.steps.some((block) => block.type === 'tool') ? (
          <FeedBlocks key={index} {...props} blocks={[...turn.steps, ...turn.answer]} />
        ) : (
          <Fragment key={index}>
            <Steps {...props} blocks={turn.steps} />
            <ChangeSummary host={props.host} blocks={turn.steps} />
            <FeedBlocks {...props} blocks={turn.answer} />
          </Fragment>
        ),
      )}
    </>
  )
})
