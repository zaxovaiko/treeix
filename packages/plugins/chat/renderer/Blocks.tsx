import { MultiFileDiff } from '@pierre/diffs/react'
import { useMemo, useState } from 'react'
import type { PermissionOption, ToolCall, ToolOutput } from '@treeix/sdk'
import { useHost } from '@treeix/sdk'
import { codeThemeOptions, diffBackground } from '@treeix/app/FileView'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { useSettings } from '@treeix/app/settings'
import { baseName } from '@treeix/app/Sidebar'
import { type Block, diffCounts, fileTarget, type PendingPermission } from './feed'

type Diff = Extract<ToolOutput, { type: 'diff' }>

const COLLAPSED_LINES = 10

/** Agent text can name any image URL, and loading it would leak to that server; remote ones show as their URL, data: images inline */
const inlineOnly = (src: string): Promise<string> | null => (src.startsWith('data:') ? null : Promise.reject(new Error(src)))

const texts = (call: ToolCall): string =>
  call.output
    .map((output) => (output.type === 'text' ? output.text : ''))
    .filter(Boolean)
    .join('\n')

const diffs = (call: ToolCall): Diff[] => call.output.filter((output): output is Diff => output.type === 'diff')

export const firstAllow = (options: PermissionOption[]): PermissionOption | undefined => options.find((option) => option.kind.startsWith('allow'))
export const firstReject = (options: PermissionOption[]): PermissionOption | undefined => options.find((option) => option.kind.startsWith('reject'))

export function TextBlock({ block }: { block: Extract<Block, { type: 'text' }> }): React.JSX.Element {
  if (block.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-foreground select-text">
          {block.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {block.images.map((image, index) => (
                <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="" className="h-16 rounded-md object-cover ring-1 ring-border" />
              ))}
            </div>
          )}
          {block.text}
        </div>
      </div>
    )
  }
  return (
    <div className="text-sm select-text">
      <LazyMarkdown resolveImage={inlineOnly}>{block.text}</LazyMarkdown>
    </div>
  )
}

export function ThoughtBlock({ block }: { block: Extract<Block, { type: 'thought' }> }): React.JSX.Element | null {
  const { chatThinking } = useSettings()
  const [open, setOpen] = useState(chatThinking === 'expanded')
  if (chatThinking === 'hidden') return null
  const running = block.endedAt === null
  const seconds = block.endedAt === null ? 0 : Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000))
  return (
    <div className="text-xs text-muted-foreground">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 hover:text-foreground">
        <Icon name="chevron" className={`size-3 transition-transform ${open || running ? 'rotate-90' : ''}`} />
        {running ? 'Thinking…' : `Thought for ${seconds}s`}
      </button>
      {(open || running) && <div className="mt-1 border-l border-border pl-3 whitespace-pre-wrap italic select-text">{block.text}</div>}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCall['status'] }): React.JSX.Element | null {
  if (status === 'completed') return <Icon name="check" className="size-3.5 text-emerald-400" />
  if (status === 'failed') return <Icon name="alert" className="size-3.5 text-red-400" />
  return <Icon name="loader" className="size-3.5 animate-spin text-sky-400" />
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
  const { added, removed } = diffCounts(diff.oldText, diff.newText)
  return (
    <span className="shrink-0 font-mono">
      <span className="text-emerald-400">+{added}</span> <span className="text-red-400">-{removed}</span>
    </span>
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
  const expandable = isLookup ? output !== '' : !isEdit && call.kind !== 'execute'
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
        {expandable && <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />}
      </div>
      {isEdit &&
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
      {call.kind === 'execute' && output !== '' && <Output text={output} collapseAfter={COLLAPSED_LINES} />}
      {isLookup && open && <Output text={output} collapseAfter={null} />}
      {!isLookup && !isEdit && call.kind !== 'execute' && open && (
        <Output text={output || JSON.stringify(call.rawInput, null, 2) || ''} collapseAfter={null} />
      )}
      {children}
    </div>
  )
}

export function PermissionCard({
  permission,
  newest,
  onAnswer
}: {
  permission: PendingPermission
  newest: boolean
  onAnswer: (optionId: string) => void
}): React.JSX.Element {
  const allow = firstAllow(permission.options)
  const reject = firstReject(permission.options)
  return (
    <div className="rounded-lg bg-amber-400/5 text-xs ring-1 ring-amber-400/40">
      <div className="flex items-center gap-2 px-3 py-1.5 text-foreground">
        <Icon name="alert" className="size-3.5 text-amber-400" />
        <span className="min-w-0 truncate">{permission.title}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-amber-400/20 px-3 py-2">
        {permission.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onAnswer(option.id)}
            className={`h-6 rounded-md px-2.5 font-medium ${option === allow ? 'bg-primary text-white' : 'text-foreground ring-1 ring-border hover:bg-accent'}`}
          >
            {option.name}
            {newest && option === allow && <span className="ml-1.5 opacity-70">⌘↵</span>}
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
