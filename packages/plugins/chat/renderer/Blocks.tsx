import { MultiFileDiff } from '@pierre/diffs/react'
import { useEffect, useMemo, useState } from 'react'
import type { PermissionOption, ToolCall, ToolOutput } from '@treeix/sdk'
import { useHost } from '@treeix/sdk'
import { codeThemeOptions, diffBackground } from '@treeix/app/FileView'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { Expandable } from '@treeix/app/Lightbox'
import { useSettings } from '@treeix/app/settings'
import { baseName } from '@treeix/app/Sidebar'
import { type Block, diffCounts, fileTarget, type PendingPermission, turnChanges } from './feed'
import { keysText } from '@treeix/shared/shortcut'
import { parseShellPrompt } from './composer'

type Diff = Extract<ToolOutput, { type: 'diff' }>

const COLLAPSED_LINES = 10

/** Agent text can name any image URL, and loading it would leak to that server; remote ones show as their URL, data: images inline */
const inlineOnly = (src: string): Promise<string> | null => (src.startsWith('data:') ? null : Promise.reject(new Error(src)))

/** Agents wrap command output in a ```console fence, which shows as text in a plain block */
const unfenced = (text: string): string => text.replace(/^```[\w-]*\n([\s\S]*?)(?:\n?```\s*)?$/, '$1')

const texts = (call: ToolCall): string =>
  call.output
    .map((output) => (output.type === 'text' ? unfenced(output.text) : ''))
    .filter(Boolean)
    .join('\n')

const diffs = (call: ToolCall): Diff[] => call.output.filter((output): output is Diff => output.type === 'diff')

export const firstAllow = (options: PermissionOption[]): PermissionOption | undefined => options.find((option) => option.kind.startsWith('allow'))
export const firstReject = (options: PermissionOption[]): PermissionOption | undefined => options.find((option) => option.kind.startsWith('reject'))

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

/** A thumbnail that opens full screen, where it zooms and pans */
export function ImageThumb({ image, className }: { image: { mimeType: string; data: string }; className: string }): React.JSX.Element {
  const src = `data:${image.mimeType};base64,${image.data}`
  return (
    <Expandable title="Image" preview={<img src={src} alt="" className={`rounded-md object-cover ring-1 ring-border ${className}`} />}>
      <img src={src} alt="" />
    </Expandable>
  )
}

const Images = ({ images, className }: { images: { mimeType: string; data: string }[]; className: string }): React.JSX.Element | null =>
  images.length === 0 ? null : (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {images.map((image, index) => (
        <ImageThumb key={index} image={image} className={className} />
      ))}
    </div>
  )

export function TextBlock({ block }: { block: Extract<Block, { type: 'text' }> }): React.JSX.Element {
  const shell = block.role === 'user' ? parseShellPrompt(block.text) : null
  if (shell)
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] min-w-0 rounded-2xl rounded-br-md bg-muted px-3.5 py-2 font-mono text-xs text-foreground select-text">
          <div className="break-all whitespace-pre-wrap">
            <span className="text-muted-foreground">! </span>
            {shell.command}
          </div>
          {shell.output && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap text-muted-foreground">{shell.output}</pre>}
        </div>
      </div>
    )
  if (block.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap text-foreground select-text">
          <Images images={block.images} className="h-20 max-w-48" />
          {block.text}
        </div>
      </div>
    )
  }
  return <AgentText block={block} />
}

/** The agent's reply as markdown, or as the source it wrote */
function AgentText({ block }: { block: Extract<Block, { type: 'text' }> }): React.JSX.Element {
  const [raw, setRaw] = useState(false)
  return (
    <div className="group/text relative text-sm select-text">
      <Images images={block.images} className="max-h-64 max-w-full" />
      {block.text && (
        <>
          <button
            onClick={() => setRaw(!raw)}
            aria-pressed={raw}
            title={raw ? 'Show formatted' : 'Show markdown source'}
            className={`absolute -top-1 right-0 z-10 flex h-6 items-center gap-1 rounded-full bg-background px-2 text-[11px] text-muted-foreground ring-1 ring-border group-hover/text:visible hover:text-foreground focus-visible:visible ${raw ? 'visible' : 'invisible'}`}
          >
            <Icon name={raw ? 'eye' : 'code'} className="size-3" />
            {raw ? 'Preview' : 'Raw'}
          </button>
          {raw ? (
            <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{block.text}</pre>
          ) : (
            <LazyMarkdown resolveImage={inlineOnly}>{block.text}</LazyMarkdown>
          )}
        </>
      )}
    </div>
  )
}

export function ThoughtBlock({ block }: { block: Extract<Block, { type: 'thought' }> }): React.JSX.Element | null {
  const { chatThinking } = useSettings()
  const [open, setOpen] = useState(chatThinking === 'expanded')
  const running = block.endedAt === null
  const elapsed = useElapsed(block.startedAt, running)
  if (chatThinking === 'hidden') return null
  const seconds = block.endedAt === null ? elapsed : Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000))
  return (
    <div className="text-xs text-muted-foreground">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 hover:text-foreground">
        <Icon name="chevron" className={`size-3 transition-transform ${open || running ? 'rotate-90' : ''}`} />
        {running ? <span className="shimmer">Thinking… {formatElapsed(seconds)}</span> : `Thought for ${formatElapsed(seconds)}`}
      </button>
      {(open || running) && <div className="mt-1 border-l border-border pl-3 whitespace-pre-wrap italic select-text">{block.text}</div>}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCall['status'] }): React.JSX.Element | null {
  if (status === 'completed') return <Icon name="check" className="size-3.5 text-emerald-400" />
  if (status === 'failed') return <Icon name="alert" className="size-3.5 text-red-400" />
  return <Icon name="loader" className="size-3.5 animate-spin text-muted-foreground" />
}

function openFile(host: ReturnType<typeof useHost>, cwd: string, path: string, line: number | null): void {
  const target = fileTarget(cwd, path)
  host.openTab({
    key: `chat-file:${target.root}:${target.path}`,
    title: baseName(path),
    icon: <FileIcon path={path} />,
    parent: 'terminal',
    content: host.renderFileView(target.root, target.path, line)
  })
}

function Location({ cwd, path, line }: { cwd: string; path: string; line: number | null }): React.JSX.Element {
  const host = useHost()
  const shown = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  return (
    <button
      onClick={(event) => {
        event.stopPropagation()
        openFile(host, cwd, path, line)
      }}
      className="min-w-0 truncate font-mono text-muted-foreground hover:text-foreground hover:underline"
      title={path}
    >
      {shown}
      {line !== null && `:${line}`}
    </button>
  )
}

/** FNV-1a, so a cache key changes with the text without holding it */
const hash = (text: string): string => {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193)
  return (value >>> 0).toString(36)
}

function DiffView({ callId, diff }: { callId: string; diff: Diff }): React.JSX.Element {
  'use no memo' // the code theme is read from settings during render
  useSettings()
  const oldKey = useMemo(() => hash(diff.oldText ?? ''), [diff.oldText])
  const newKey = useMemo(() => hash(diff.newText), [diff.newText])
  return (
    <MultiFileDiff
      oldFile={{ name: diff.path, contents: diff.oldText ?? '', cacheKey: `chat:${callId}:${diff.path}:old:${oldKey}` }}
      newFile={{ name: diff.path, contents: diff.newText, cacheKey: `chat:${callId}:${diff.path}:new:${newKey}` }}
      className="block"
      style={diffBackground()}
      options={{ ...codeThemeOptions(), diffStyle: 'unified' }}
    />
  )
}

function DiffCount({ diff }: { diff: Diff }): React.JSX.Element {
  return <Counts {...diffCounts(diff.oldText, diff.newText)} />
}

const Counts = ({ added, removed }: { added: number; removed: number }): React.JSX.Element => (
  <span className="shrink-0 font-mono">
    <span className="text-emerald-400">+{added}</span> <span className="text-red-400">-{removed}</span>
  </span>
)

/** The files a finished turn changed, so its edits read without unfolding its steps */
export function ChangeSummary({ blocks, cwd }: { blocks: Block[]; cwd: string }): React.JSX.Element | null {
  const files = turnChanges(blocks)
  if (!files.length) return null
  const total = files.reduce(
    (sum, file) => ({
      added: sum.added + file.added,
      removed: sum.removed + file.removed
    }),
    { added: 0, removed: 0 }
  )
  return (
    <div className="overflow-hidden rounded-lg text-xs ring-1 ring-border">
      <div className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
        <span className="flex-1">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <Counts {...total} />
      </div>
      {files.map((file) => (
        <div key={file.path} className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1">
          <FileIcon path={file.path} />
          <Location cwd={cwd} path={file.path} line={null} />
          <span className="flex-1" />
          <Counts {...file} />
        </div>
      ))}
    </div>
  )
}

function Output({ text, collapseAfter }: { text: string; collapseAfter: number | null }): React.JSX.Element {
  const [full, setFull] = useState(false)
  const lines = text.split('\n')
  const cut = collapseAfter !== null && !full && lines.length > collapseAfter
  return (
    <div className="border-t border-border">
      <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground select-text">
        {cut ? lines.slice(0, collapseAfter).join('\n') : text}
      </pre>
      {cut && (
        <button onClick={() => setFull(true)} className="px-3 pb-2 text-xs text-muted-foreground hover:text-foreground">
          Show {lines.length - collapseAfter} more lines
        </button>
      )}
    </div>
  )
}

export function ToolCard({ call, cwd, children }: { call: ToolCall; cwd: string; children?: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const output = texts(call)
  const location = call.locations[0]
  const changes = diffs(call)
  const isEdit = call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move'
  const isLookup = call.kind === 'read' || call.kind === 'search' || call.kind === 'fetch'
  const details = isEdit ? '' : output || (isLookup || call.kind === 'execute' ? '' : JSON.stringify(call.rawInput, null, 2) || '')
  const expandable = isEdit ? changes.length > 0 : details !== ''
  const total = changes.reduce(
    (sum, diff) => {
      const counts = diffCounts(diff.oldText, diff.newText)
      return { added: sum.added + counts.added, removed: sum.removed + counts.removed }
    },
    { added: 0, removed: 0 }
  )
  return (
    <div className="overflow-hidden rounded-lg text-xs ring-1 ring-border">
      <div
        onClick={expandable ? () => setOpen(!open) : undefined}
        className={`flex min-w-0 items-center gap-2 px-3 py-1.5 ${expandable ? 'cursor-pointer hover:bg-accent/50' : ''}`}
      >
        <StatusIcon status={call.status} />
        <span className={`min-w-0 truncate ${call.kind === 'execute' ? 'font-mono' : ''} text-foreground`}>{call.title}</span>
        {location && !isEdit && <Location cwd={cwd} path={location.path} line={location.line} />}
        <span className="flex-1" />
        {changes.length > 0 && <Counts {...total} />}
        {expandable && <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />}
      </div>
      {isEdit &&
        open &&
        changes.map((diff) => (
          <div key={diff.path} className="border-t border-border">
            <div className="flex items-center gap-2 px-3 py-1">
              <FileIcon path={diff.path} />
              <Location cwd={cwd} path={diff.path} line={null} />
              <span className="flex-1" />
              <DiffCount diff={diff} />
            </div>
            <DiffView callId={call.id} diff={diff} />
          </div>
        ))}
      {!isEdit && open && <Output text={details} collapseAfter={call.kind === 'execute' ? COLLAPSED_LINES : null} />}
      {children}
    </div>
  )
}

export function PermissionCard({ permission, newest, onAnswer }: { permission: PendingPermission; newest: boolean; onAnswer: (optionId: string) => void }): React.JSX.Element {
  const allow = firstAllow(permission.options)
  const reject = firstReject(permission.options)
  return (
    <div className="rounded-2xl bg-amber-400/5 text-xs ring-1 ring-amber-400/40">
      <div className="flex items-center gap-2 px-3.5 py-2 text-foreground">
        <Icon name="alert" className="size-3.5 text-amber-400" />
        <span className="min-w-0 truncate">{permission.title}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-amber-400/20 px-3 py-2.5">
        {permission.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onAnswer(option.id)}
            className={`h-7 rounded-full px-3 font-medium ${option === allow ? 'bg-foreground text-on-foreground' : 'text-foreground ring-1 ring-input hover:bg-accent'}`}
          >
            {option.name}
            {newest && option === allow && <span className="ml-1.5 opacity-70">{keysText('⌘↵')}</span>}
            {newest && option === reject && <span className="ml-1.5 text-muted-foreground">Esc</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ErrorBlock({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-400/5 px-3 py-2 text-xs text-red-300 ring-1 ring-red-400/30">
      <Icon name="alert" className="mt-px size-3.5 shrink-0 text-red-400" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap select-text">{message}</span>
    </div>
  )
}
