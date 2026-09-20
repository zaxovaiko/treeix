import { actionForEvent } from '../../shared/keymap'
import { useEffect, useRef, useState } from 'react'
import { type Attachment, formatComments, type LineRange, rangeLabel, type ReviewComment, type Side } from '../../shared/comments'
import { focusZone, KeyHintLabel, Keys } from '@treeix/sdk'
import { copyText, openMenu } from './contextMenu'
import { FileIcon, Icon } from './Icon'
import { LazyMarkdown as Markdown } from './LazyMarkdown'
import { EmptyState, errorMessage } from './ui'

type LinePoint = { lineNumber: number; side?: Side }

export function orderRange(range: LineRange): LineRange {
  const sameSide = (range.endSide ?? range.side) === range.side
  return sameSide && range.start > range.end ? { ...range, start: range.end, end: range.start } : range
}

// Line numbers are handled by the diff library itself; this covers drags over code
const startsOnCode = (event: React.PointerEvent): boolean =>
  event.button === 0 &&
  !event.nativeEvent
    .composedPath()
    .some(
      (element) =>
        element instanceof Element &&
        (element.hasAttribute('data-column-number') || ['TEXTAREA', 'BUTTON'].includes(element.tagName))
    )

/** Drag across code lines to select a range; the library only supports dragging line numbers */
export function useCodeDrag(onSelect: (range: LineRange) => void): {
  range: LineRange | null
  enterLine: (line: LinePoint) => void
  onPointerDown: (event: React.PointerEvent) => void
} {
  const [range, setRange] = useState<LineRange | null>(null)
  const hovered = useRef<LinePoint | null>(null)
  const anchor = useRef<LinePoint | null>(null)

  useEffect(() => {
    const endDrag = (): void => {
      if (range && (range.start !== range.end || range.side !== range.endSide)) onSelect(orderRange(range))
      anchor.current = null
      setRange(null)
    }
    document.addEventListener('pointerup', endDrag)
    return () => document.removeEventListener('pointerup', endDrag)
  }, [range, onSelect])

  const enterLine = (line: LinePoint): void => {
    hovered.current = line
    const start = anchor.current
    if (!start || (start.lineNumber === line.lineNumber && start.side === line.side && !range)) return
    window.getSelection()?.removeAllRanges()
    setRange({ start: start.lineNumber, side: start.side, end: line.lineNumber, endSide: line.side })
  }

  const onPointerDown = (event: React.PointerEvent): void => {
    if (startsOnCode(event)) anchor.current = hovered.current
  }

  return { range, enterLine, onPointerDown }
}

const THUMBNAIL_PX = 160

/** Downscaled JPEG so previews stay small in localStorage; agents get the full file by path */
async function thumbnailOf(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return undefined
  const scale = Math.min(1, THUMBNAIL_PX / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.8)
}

async function storeAttachment(file: File): Promise<Attachment> {
  const [path, thumbnail] = await Promise.all([
    window.api.saveAttachment(file.name || 'pasted-file', new Uint8Array(await file.arrayBuffer())),
    thumbnailOf(file)
  ])
  return { path, name: file.name || 'pasted-file', thumbnail }
}

export function Attachments({
  attachments,
  size = 'md',
  onRemove
}: {
  attachments: Attachment[]
  size?: 'sm' | 'md'
  onRemove?: (attachment: Attachment) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  const box = size === 'sm' ? 'size-10' : 'size-16'
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <div
          key={attachment.path}
          title={attachment.path}
          className={`group/file relative shrink-0 overflow-hidden rounded-md border border-border bg-muted ${attachment.thumbnail ? box : 'flex h-8 max-w-48 items-center gap-1.5 px-2'}`}
        >
          {attachment.thumbnail ? (
            <img src={attachment.thumbnail} alt={attachment.name} className="size-full object-cover" />
          ) : (
            <>
              <FileIcon path={attachment.name} />
              <span className="truncate text-[11px] text-foreground/80">{attachment.name}</span>
            </>
          )}
          {onRemove && (
            <button
              title="Remove attachment"
              onClick={() => onRemove(attachment)}
              className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
            >
              <Icon name="close" className="size-2.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

const cardClass = 'mx-3 my-2 rounded-lg border border-border bg-card font-sans text-[13px] text-foreground shadow-sm'

export function CommentCard({ comment, onDelete }: { comment: ReviewComment; onDelete: () => void }): React.JSX.Element {
  return (
    <div
      className={`${cardClass} group/comment flex items-start gap-2 px-3 py-2`}
      onContextMenu={(event) =>
        openMenu(event, [
          { label: 'Copy comment', run: () => copyText(comment.text) },
          { label: 'Copy as agent prompt', run: () => copyText(formatComments([comment])) },
          null,
          { label: 'Delete comment', run: onDelete }
        ])
      }
    >
      <Icon name="comment" className="mt-0.5 size-3.5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{comment.range.start > 0 ? `Line ${rangeLabel(comment.range)}` : comment.kind === 'reference' ? 'Reference' : 'General'}</div>
        <Markdown>{comment.text}</Markdown>
        <Attachments attachments={comment.attachments ?? []} />
      </div>
      <button
        title="Delete comment"
        onClick={onDelete}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/comment:opacity-100 hover:bg-accent focus-visible:opacity-100 hover:text-foreground"
      >
        <Icon name="close" className="size-3" />
      </button>
    </div>
  )
}

export function CommentDraft({
  label,
  placeholder = 'Leave a note for the agent',
  submitLabel = 'Comment',
  allowAttachments = true,
  onSave,
  onCancel,
  alternative,
  persistent = false
}: {
  label: string
  placeholder?: string
  submitLabel?: string
  allowAttachments?: boolean
  onSave: (text: string, attachments: Attachment[]) => void | Promise<void>
  onCancel: () => void
  /** A second way to save the text, e.g. as an agent comment instead of posting it; ⌘⇧↵ */
  alternative?: { label: string; onSave: (text: string) => void }
  /** Always on screen: no autofocus, Esc and Cancel only clear it while it has focus, and it empties after saving */
  persistent?: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const cancel = (): void => {
    if (persistent) {
      setText('')
      setAttachments([])
      textareaRef.current?.blur()
    }
    onCancel()
  }

  // autoFocus fires before the diff mounts the annotation slot
  useEffect(() => {
    if (persistent) return
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (persistent && !cardRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', cancelOnEscape, true)
    return () => window.removeEventListener('keydown', cancelOnEscape, true)
  }, [onCancel, persistent])

  const attach = (files: File[]): void => {
    if (!allowAttachments || files.length === 0) return
    setBusy(true)
    Promise.all(files.map(storeAttachment))
      .then((stored) => setAttachments((current) => [...current, ...stored]))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  const canSave = text.trim().length > 0 && !busy
  const save = (): void => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    Promise.resolve(onSave(text, attachments))
      .then(() => {
        if (!persistent) return
        setText('')
        setAttachments([])
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <div
      ref={cardRef}
      className={`${cardClass} p-2`}
      onDragOver={(event) => allowAttachments && event.preventDefault()}
      onDrop={(event) => {
        if (!allowAttachments) return
        event.preventDefault()
        attach([...event.dataTransfer.files])
      }}
    >
      <div className="px-1 pb-1.5 text-[11px] text-muted-foreground">{label}</div>
      <textarea
        ref={textareaRef}
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files]
          if (files.length === 0 || !allowAttachments) return
          event.preventDefault()
          attach(files)
        }}
        onKeyDown={(event) => {
          const id = actionForEvent(event.nativeEvent, ['composer.saveAlternative', 'composer.save'])
          if (!id) return
          if (id === 'composer.saveAlternative' && alternative) {
            if (text.trim()) alternative.onSave(text)
          } else if (id === 'composer.save') save()
        }}
        placeholder={allowAttachments ? `${placeholder}. Paste or drop files to attach` : placeholder}
        className="w-full resize-y rounded-md border border-input bg-muted px-2 py-1.5 leading-5 outline-none placeholder:text-muted-foreground/70"
      />
      <Attachments attachments={attachments} onRemove={(removed) => setAttachments(attachments.filter((file) => file !== removed))} />
      {error && <p className="px-1 pt-1.5 text-[11px] break-words text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-1.5 pt-1.5">
        {allowAttachments && (
          <>
            <button
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon name="paperclip" className="size-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attach([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
          </>
        )}
        <span className="mr-auto truncate px-1 text-[11px] whitespace-nowrap text-muted-foreground">⌘↵ save · esc cancel</span>
        {(!persistent || text) && (
          <button onClick={cancel} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
        )}
        {alternative && (
          <button
            title="⌘⇧↵"
            onClick={() => alternative.onSave(text)}
            disabled={!text.trim()}
            className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground ring-1 ring-border hover:bg-accent disabled:opacity-40"
          >
            <Icon name="comment" className="size-3.5" />
            {alternative.label}
          </button>
        )}
        <button onClick={save} disabled={!canSave} className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-white disabled:opacity-40">
          {busy ? '...' : submitLabel}
        </button>
      </div>
    </div>
  )
}

export function CommentsPanel({
  comments,
  footer,
  onClear,
  onOpen,
  onDelete
}: {
  comments: ReviewComment[]
  footer: React.ReactNode
  onClear: () => void
  onOpen: (comment: ReviewComment) => void
  onDelete: (comment: ReviewComment) => void
}): React.JSX.Element {
  const filePaths = [...new Set(comments.map((comment) => comment.filePath))]
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs text-muted-foreground">
          {comments.length} on this worktree
        </span>
        <span className="flex-1" />
        {comments.length > 0 && (
          <button
            onClick={onClear}
            className="h-6 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {comments.length === 0 && (
          <EmptyState icon="comment" title="No comments yet. Drag across lines or line numbers in the diff to leave one." />
        )}
        {filePaths.map((filePath) => (
          <div key={filePath} className="mb-2">
            <div className="truncate px-2 py-1 font-mono text-[11px] text-muted-foreground" title={filePath}>
              {filePath}
            </div>
            {comments
              .filter((comment) => comment.filePath === filePath)
              .map((comment) => (
                <div
                  key={comment.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(comment)}
                  onContextMenu={(event) =>
                    openMenu(event, [
                      { label: 'Go to comment', run: () => onOpen(comment) },
                      null,
                      { label: 'Copy comment', run: () => copyText(comment.text) },
                      { label: 'Copy as agent prompt', run: () => copyText(formatComments([comment])) },
                      null,
                      { label: 'Delete comment', run: () => onDelete(comment) }
                    ])
                  }
                  onKeyDown={(event) => event.key === 'Enter' && onOpen(comment)}
                  className="group/item mb-1 cursor-pointer rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-accent"
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{comment.range.start > 0 ? `Line ${rangeLabel(comment.range)}` : comment.kind === 'reference' ? 'Reference' : 'General'}</span>
                    <span className="flex-1" />
                    <button
                      title="Delete comment"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(comment)
                      }}
                      className="inline-flex size-5 items-center justify-center rounded opacity-0 group-hover/item:opacity-100 hover:text-foreground focus-visible:opacity-100"
                    >
                      <Icon name="close" className="size-3" />
                    </button>
                  </div>
                  <p className="line-clamp-4 text-[13px] whitespace-pre-wrap text-foreground/90">{comment.text}</p>
                  <Attachments attachments={comment.attachments ?? []} size="sm" />
                  {comment.code && (
                    <pre className="mt-1 max-h-16 overflow-hidden rounded bg-muted px-1.5 py-1 font-mono text-[10.5px] leading-4 text-muted-foreground">
                      {comment.code}
                    </pre>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>

      {comments.length > 0 && <div className="shrink-0 border-t border-border p-2">{footer}</div>}
    </div>
  )
}

/**
 * ⌘I: every agent comment of the workspace, grouped by worktree, each group sent to a session in that checkout.
 * j k move, Enter opens, d removes, ⇧X clears all; t and ⌘↵ reach the focused group's send button. Stays open until
 * esc or ⌘I, and hands focus back to where it came from.
 */
export function AgentCommentsDrawer({
  comments,
  labelOf,
  top,
  bottom,
  renderSend,
  onOpen,
  onOpenWorktree,
  onDelete,
  onClearAll,
  onClose
}: {
  comments: ReviewComment[]
  labelOf: (worktreePath: string) => string
  top: number
  bottom: number
  /** The send button for a worktree's comments; `active` gives it the drawer's t and ⌘↵ */
  renderSend: (worktreePath: string, active: boolean) => React.ReactNode
  onOpen: (comment: ReviewComment) => void
  onOpenWorktree: (worktreePath: string) => void
  onDelete: (comment: ReviewComment) => void
  onClearAll: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const paths = [...new Set(comments.map((comment) => comment.worktreePath))]
  const ordered = paths.flatMap((path) => comments.filter((comment) => comment.worktreePath === path))
  const [cursorId, setCursorId] = useState<string | null>(null)
  const found = ordered.findIndex((comment) => comment.id === cursorId)
  const index = Math.max(0, found)
  const current: ReviewComment | undefined = ordered[index]
  const latest = useRef({ ordered, index, current, onOpen, onDelete, onClearAll, onClose })
  latest.current = { ordered, index, current, onOpen, onDelete, onClearAll, onClose }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      const { ordered, index, current, onOpen, onDelete, onClearAll, onClose } = latest.current
      const inside = document.activeElement === document.body || ref.current?.contains(document.activeElement)
      // cancelBubble: an earlier capture listener, like the shortcut sheet over the drawer, kept the key
      if (event.defaultPrevented || event.cancelBubble || !inside || event.metaKey || event.ctrlKey || event.altKey) return
      const moveTo = (next: number): void => setCursorId(ordered[Math.max(0, Math.min(ordered.length - 1, next))]?.id ?? null)
      const action =
        event.key === 'Escape' ? onClose
        : event.key === 'j' || event.key === 'ArrowDown' ? () => moveTo(index + 1)
        : event.key === 'k' || event.key === 'ArrowUp' ? () => moveTo(index - 1)
        : event.key === 'Enter' && current && !(event.target instanceof Element && event.target.closest('button')) ? () => onOpen(current)
        : (event.key === 'd' || event.key === 'Backspace' || event.key === 'Delete') && current ? () => {
            onDelete(current)
            setCursorId(ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null)
          }
        : event.key === 'X' && ordered.length > 0 ? onClearAll
        : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    // Capture, so the page under the drawer (like Settings' esc and /) never sees the drawer's keys
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true })
      else focusZone('main')
    }
  }, [])

  return (
    <div
      ref={ref}
      data-drawer
      tabIndex={-1}
      style={{ top, bottom }}
      className="fixed right-0 z-[45] flex w-[440px] max-w-[90vw] flex-col border-l border-input bg-popover shadow-2xl shadow-black/60 outline-none [-webkit-app-region:no-drag]"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="comment" className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">Agent comments</span>
        <span className="text-xs text-muted-foreground tabular-nums">{comments.length}</span>
        <span className="flex-1" />
        <button title="Close (esc or ⌘I)" aria-label="Close agent comments" onClick={onClose} className="flex h-6 items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Keys combo="esc" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {comments.length === 0 && (
          <EmptyState icon="comment" title="No agent comments yet. Press c on a diff line, or a on a pull request thread, ticket or page, to collect it here." />
        )}
        {paths.map((path) => {
          const group = comments.filter((comment) => comment.worktreePath === path)
          const active = current?.worktreePath === path
          return (
            <section key={path} className={`mb-2 rounded-lg p-1.5 ring-1 ${active ? 'ring-input' : 'ring-border'}`}>
              <button onClick={() => onOpenWorktree(path)} title={`Open ${path}`} className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium hover:bg-accent">
                <Icon name="branch" className="size-3.5 text-emerald-400" />
                <span className="min-w-0 truncate">{labelOf(path)}</span>
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{group.length}</span>
              </button>
              {group.map((comment) => {
                const isCursor = comment.id === current?.id
                return (
                  <div
                    key={comment.id}
                    onClick={() => {
                      setCursorId(comment.id)
                      onOpen(comment)
                    }}
                    className={`mt-1 cursor-default rounded-md p-2 ring-1 ${isCursor ? 'bg-foreground/[.08] ring-input' : 'ring-border hover:bg-accent'}`}
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="min-w-0 truncate font-mono" title={comment.filePath}>
                        {comment.filePath}
                        {comment.range.start > 0 ? `:${rangeLabel(comment.range)}` : ''}
                      </span>
                      <span className="flex-1" />
                      <button
                        title="Remove (d)"
                        aria-label="Remove comment"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDelete(comment)
                        }}
                        className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent hover:text-foreground"
                      >
                        <Icon name="close" className="size-3" />
                      </button>
                    </div>
                    {comment.code && <div className="mt-1.5 truncate rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground/75">{comment.code.split('\n')[0]}</div>}
                    <div className="mt-1.5 text-xs break-words whitespace-pre-wrap text-foreground/90">{comment.text}</div>
                    <Attachments attachments={comment.attachments ?? []} size="sm" />
                  </div>
                )
              })}
              <div className="mt-1.5">{renderSend(path, active)}</div>
            </section>
          )
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {(
          [
            ['j k', 'move'],
            ['⏎', 'open'],
            ['d', 'remove'],
            ['⇧X', 'clear'],
            ['t', 'target'],
            ['⌘⏎', 'send']
          ] as const
        ).map((hint) => (
          <KeyHintLabel key={hint[0]} hint={[hint[0], hint[1]]} />
        ))}
      </div>
    </div>
  )
}
