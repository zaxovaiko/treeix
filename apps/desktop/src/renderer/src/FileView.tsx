import { File, type LineAnnotation, MultiFileDiff, Virtualizer } from '@pierre/diffs/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getShell, isPageKey } from '@treeix/sdk'
import { type Attachment, extractFileLines, type LineRange, rangeLabel, type ReviewComment } from '../../shared/comments'
import { CommentCard, CommentDraft, orderRange, useCodeDrag } from './Comments'
import { type Navigate, useSymbolNavigation } from './codeNavigation'
import { Icon } from './Icon'
import { CodeEditor, type CodeEditorHandle } from './monaco/CodeEditor'
import { EditorComments, useEditorNavigation } from './monaco/comments'
import { normalizeEol } from './monaco/text'
import { EmptyState } from './ui'

import { activeTheme, getSettings } from './settings'
import { THEMES, withAlpha } from './themes'

/** The diff renders in a shadow root with its own background, so pass the theme color in */
export const diffBackground = (): React.CSSProperties => {
  const background = withAlpha(THEMES[activeTheme()].background, getSettings().opacity / 100)
  return { '--diffs-dark-bg': background, '--diffs-light-bg': background } as React.CSSProperties
}
/** Both pierre themes load; themeType picks the one matching the app theme */
export const codeThemeOptions = (): { theme: { dark: 'pierre-dark'; light: 'pierre-light' }; themeType: 'dark' | 'light' } => ({
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: THEMES[activeTheme()].mode
})
const SCROLL_ATTEMPTS = 60

/** Cheap content fingerprint so highlight caches don't serve a stale version of an edited file */
function contentHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = (hash * 33) ^ text.charCodeAt(index)
  return (hash >>> 0).toString(36)
}

/** The gutter cell of a line, inside the viewer's shadow roots; `type` picks a side of a diff, like change-addition */
export function findLineElement(root: ParentNode, line: number, type?: string): Element | null {
  const direct = root.querySelector(`[data-column-number="${line}"]${type ? `[data-line-type="${type}"]` : ''}`)
  if (direct) return direct
  for (const element of root.querySelectorAll('*')) {
    const nested = element.shadowRoot && findLineElement(element.shadowRoot, line, type)
    if (nested) return nested
  }
  return null
}

const AUTOSAVE_DELAY_MS = 800

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i

/** Pictures show as themselves, on a checkerboard so transparency reads; everything else opens as code */
export function FileView(props: Parameters<typeof TextFileView>[0]): React.JSX.Element {
  return IMAGE_PATH.test(props.path) && props.contents === undefined ? <ImageView worktreePath={props.worktreePath} path={props.path} /> : <TextFileView {...props} />
}

function ImageView({ worktreePath, path }: { worktreePath: string; path: string }): React.JSX.Element {
  const [source, setSource] = useState<{ path: string; url: string | null } | null>(null)
  const [size, setSize] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    setSize(null)
    void window.api.readImage(worktreePath, path).then((url) => stale || setSource({ path, url }))
    return () => {
      stale = true
    }
  }, [worktreePath, path])
  if (source?.path !== path) return <EmptyState fill title="Loading..." />
  if (!source.url) return <EmptyState fill icon="file" title="Image too large to preview" />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid min-h-0 flex-1 place-items-center overflow-auto p-6"
        style={{ backgroundImage: 'repeating-conic-gradient(var(--color-muted) 0 25%, transparent 0 50%)', backgroundSize: '16px 16px' }}
      >
        <img
          src={source.url}
          alt={path}
          onLoad={(event) => setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
          className="max-h-full max-w-full object-contain [image-rendering:auto]"
        />
      </div>
      {size && <div className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-muted-foreground tabular-nums">{size}</div>}
    </div>
  )
}

function TextFileView({
  worktreePath,
  path,
  line,
  contents: providedContents,
  comments,
  onNavigate,
  onAddComment,
  onDeleteComment,
  onSaved,
  onShowHistory
}: {
  worktreePath: string
  path: string
  line: number | null
  /** Skip reading from the worktree, e.g. for Claude plans */
  contents?: string | null
  comments: ReviewComment[]
  onNavigate: Navigate
  onAddComment: (range: LineRange, code: string, text: string, attachments: Attachment[]) => void
  onDeleteComment: (comment: ReviewComment) => void
  /** Makes the file editable with autosave; called after each save so diffs can refresh */
  onSaved?: () => void
  onShowHistory?: () => void
}): React.JSX.Element {
  const [loadedContents, setContents] = useState<string | null | undefined>(undefined)
  const contents = providedContents === undefined ? loadedContents : providedContents
  const [draft, setDraft] = useState<LineRange | null>(null)
  const drag = useCodeDrag(setDraft)
  const scrollRef = useRef<HTMLDivElement>(null)
  const symbols = useSymbolNavigation({ worktreePath, path, onNavigate })
  const editable = Boolean(onSaved) && providedContents === undefined
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'failed'>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Editor text as typed; the component's `file` prop stays at the loaded version so typing isn't reset */
  const latest = useRef<string | null>(null)
  const onDisk = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Disk text that changed underneath unsaved edits; autosave pauses until the user picks a side */
  const [conflict, setConflict] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const conflictRef = useRef<string | null>(null)
  conflictRef.current = conflict
  const version = useMemo(() => (contents ? contentHash(contents) : ''), [contents])
  const [editor, setEditor] = useState<CodeEditorHandle | null>(null)
  useEditorNavigation(editor, worktreePath, path, onNavigate)

  const loadFromDisk = (text: string): void => {
    onDisk.current = text
    latest.current = null
    setConflict(null)
    setComparing(false)
    setStatus('saved')
    setContents(text)
  }

  /** Called when the file changed on disk: follow it when nothing is unsaved, else ask */
  const checkDisk = async (): Promise<void> => {
    const text = await window.api.readFile(worktreePath, path).catch(() => null)
    if (text === null || text === onDisk.current) return
    const hasUnsaved = latest.current !== null && latest.current !== onDisk.current
    if (!hasUnsaved) return loadFromDisk(text)
    clearTimeout(timer.current)
    setConflict(text)
    setStatus('pending')
  }
  const checkDiskRef = useRef(checkDisk)
  checkDiskRef.current = checkDisk

  const keepMine = (): void => {
    const disk = conflictRef.current
    const mine = latest.current
    if (disk === null || mine === null) return
    onDisk.current = disk
    setConflict(null)
    setComparing(false)
    flushRef.current()
  }

  const flush = (): void => {
    clearTimeout(timer.current)
    const text = latest.current
    if (text === null || text === onDisk.current || conflictRef.current !== null) return
    setStatus('saving')
    window.api.saveFile(worktreePath, path, text, onDisk.current).then(
      () => {
        onDisk.current = text
        setStatus(latest.current === text ? 'saved' : 'pending')
        setSaveError(null)
        onSaved?.()
      },
      (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message.includes('SAVE_CONFLICT')) return void checkDiskRef.current()
        setStatus('failed')
        setSaveError(message)
      }
    )
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  // ⌘S saves right away instead of waiting for the pause
  useEffect(() => {
    if (!editable) return
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.code !== 'KeyS') return
      event.preventDefault()
      flushRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editable])

  // c or a: an agent comment on the line the file was opened at, while the editor isn't typing
  useEffect(() => {
    if (!editable) return
    const onKey = (event: KeyboardEvent): void => {
      const focused = document.activeElement
      const inZone = !focused || focused === document.body || scrollRef.current?.closest('[data-zone]')?.contains(focused)
      if ((event.key !== 'c' && event.key !== 'a') || getShell().zone !== 'main' || !isPageKey(event) || !inZone) return
      event.preventDefault()
      setDraft({ start: line ?? 1, end: line ?? 1 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable, line])

  useEffect(() => {
    setDraft(null)
    setStatus('saved')
    latest.current = null
    onDisk.current = null
    if (providedContents !== undefined) return
    setContents(undefined)
    window.api.readFile(worktreePath, path).then(
      (text) => {
        onDisk.current = text
        setContents(text)
      },
      () => setContents(null)
    )
    const unwatch = window.api.watchFile(worktreePath, path, () => void checkDiskRef.current())
    // Switching files or closing the tab saves what was typed
    return () => {
      unwatch()
      flushRef.current()
    }
  }, [worktreePath, path])

  // Highlighting renders asynchronously, so poll a few frames for the target row
  useEffect(() => {
    if (editable) return
    if (!contents || !line) return
    let attempts = 0
    let frame = requestAnimationFrame(function scroll() {
      // The Virtualizer's own element is the scroller; rows far from the viewport aren't in the DOM yet
      const container = scrollRef.current?.firstElementChild
      const target = container && findLineElement(container, line)
      if (container && !target && attempts === 10) {
        const row = findLineElement(container, 1)
        const rowHeight = row?.getBoundingClientRect().height || 20
        container.scrollTop = Math.max(0, (line - 1) * rowHeight - container.clientHeight / 2)
      }
      // scrollIntoView would also scroll overflow-hidden ancestors, shoving dialogs that host this view out of place
      if (container && target) {
        const targetBox = target.getBoundingClientRect()
        const containerBox = container.getBoundingClientRect()
        container.scrollTop += targetBox.top - containerBox.top - (containerBox.height - targetBox.height) / 2
      } else if (attempts++ < SCROLL_ATTEMPTS) frame = requestAnimationFrame(scroll)
    })
    return () => cancelAnimationFrame(frame)
  }, [contents, line])

  if (contents === undefined) return <EmptyState fill title="Loading..." />
  if (contents === null) return <EmptyState fill icon="file" title="Binary or too large to preview" />

  const lineAnnotations: LineAnnotation<{ commentId: string | null }>[] = [
    ...comments.map((comment) => ({ lineNumber: comment.range.end, metadata: { commentId: comment.id } })),
    ...(draft ? [{ lineNumber: draft.end, metadata: { commentId: null } }] : [])
  ]
  const zones = editable
    ? [
        ...comments.map((comment) => ({ line: comment.range.end, key: comment.id, node: <CommentCard comment={comment} onDelete={() => onDeleteComment(comment)} /> })),
        ...(draft
          ? [
              {
                line: draft.end,
                key: 'draft',
                node: (
                  <CommentDraft
                    label={`Comment on line ${rangeLabel(draft)}`}
                    onCancel={() => setDraft(null)}
                    onSave={(text, attachments) => {
                      onAddComment(draft, extractFileLines(latest.current ?? contents, draft), text, attachments)
                      setDraft(null)
                    }}
                  />
                )
              }
            ]
          : [])
      ]
    : []

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {conflict !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-xs text-amber-200">
          <span className="flex-1">This file changed on disk while you had unsaved edits. Autosave is paused.</span>
          <button onClick={() => setComparing(!comparing)} className="h-6 rounded-md px-2 ring-1 ring-amber-400/40 hover:bg-amber-400/15">
            {comparing ? 'Back to editor' : 'Compare'}
          </button>
          <button onClick={() => loadFromDisk(conflict)} className="h-6 rounded-md px-2 ring-1 ring-amber-400/40 hover:bg-amber-400/15">
            Use disk version
          </button>
          <button onClick={keepMine} className="h-6 rounded-md bg-amber-400/90 px-2 font-medium text-black hover:bg-amber-300">
            Keep mine
          </button>
        </div>
      )}
      {conflict !== null && comparing && (
        <div className="min-h-0 flex-1 overflow-auto">
          <MultiFileDiff
            oldFile={{ name: path, contents: conflict, cacheKey: `conflict-disk:${worktreePath}:${path}:${contentHash(conflict)}` }}
            newFile={{ name: path, contents: latest.current ?? contents, cacheKey: `conflict-mine:${worktreePath}:${path}:${contentHash(latest.current ?? contents)}` }}
            className="block"
            style={diffBackground()}
            options={{ ...codeThemeOptions(), diffStyle: 'unified' }}
          />
        </div>
      )}
      {editable && (
        <div className="absolute top-1.5 right-4 z-20 flex items-center gap-0.5 rounded-md border border-border bg-popover/90 p-0.5 text-muted-foreground shadow-md shadow-black/30 backdrop-blur">
          <span
            title={
              status === 'failed'
                ? `Save failed: ${saveError ?? 'unknown error'}`
                : conflict !== null
                  ? 'Changed on disk, autosave paused'
                  : status === 'saved'
                    ? 'Saved'
                    : status === 'saving'
                      ? 'Saving…'
                      : 'Unsaved, saves when you pause'
            }
            className="grid size-6 place-items-center"
          >
            {status === 'failed' ? (
              <Icon name="alert" className="size-3.5 text-red-400" />
            ) : conflict !== null ? (
              <Icon name="alert" className="size-3.5 text-amber-400" />
            ) : status === 'saved' ? (
              <Icon name="cloudCheck" className="size-3.5 text-emerald-400" />
            ) : status === 'saving' ? (
              <Icon name="loader" className="size-3.5 text-sky-400" />
            ) : (
              <span className="size-2 rounded-full bg-amber-400" />
            )}
          </span>
          {onShowHistory && (
            <button
              title="Edit history"
              aria-label="Edit history"
              onClick={onShowHistory}
              className="grid size-6 place-items-center rounded hover:bg-accent hover:text-foreground"
            >
              <Icon name="history" className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        hidden={comparing}
        // Text selection belongs to the editor; comments start from the + in the gutter or by dragging line numbers
        onPointerDown={editable ? undefined : drag.onPointerDown}
        onContextMenu={editable ? undefined : symbols.onContextMenu}
        className={`flex min-h-0 flex-1 flex-col ${drag.range ? 'select-none' : 'select-text'}`}
      >
        {editable ? (
          <>
            <CodeEditor
              worktreePath={worktreePath}
              path={path}
              contents={contents}
              line={line}
              onChange={(text) => {
                const baseline = latest.current ?? onDisk.current
                if (baseline !== null && normalizeEol(text) === normalizeEol(baseline)) return
                latest.current = text
                setStatus('pending')
                clearTimeout(timer.current)
                timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_DELAY_MS)
              }}
              onReady={setEditor}
            />
            {editor && <EditorComments handle={editor} zones={zones} onGutterComment={setDraft} />}
          </>
        ) : (
          // Renders only rows near the viewport: a 1,200-line file was 50k DOM nodes
          <Virtualizer className="min-h-0 flex-1 overflow-auto">
            <File
              key={`${path}:${version}`}
              file={{ name: path, contents, cacheKey: `${worktreePath}:${path}:${version}` }}
              className="block"
              style={diffBackground()}
              lineAnnotations={lineAnnotations}
              selectedLines={drag.range ?? draft ?? (line ? { start: line, end: line } : null)}
              edit={editable}
              onEditChange={(event) => {
                latest.current = event.file.contents
                setStatus('pending')
                clearTimeout(timer.current)
                timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_DELAY_MS)
              }}
              onEditComplete={() => 'accept'}
              renderAnnotation={({ metadata }) => {
                const comment = comments.find((candidate) => candidate.id === metadata.commentId)
                if (comment) return <CommentCard comment={comment} onDelete={() => onDeleteComment(comment)} />
                return draft ? (
                  <CommentDraft
                    label={`Comment on line ${rangeLabel(draft)}`}
                    onCancel={() => setDraft(null)}
                    onSave={(text, attachments) => {
                      onAddComment(draft, extractFileLines(latest.current ?? contents, draft), text, attachments)
                      setDraft(null)
                    }}
                  />
                ) : null
              }}
              options={{
                ...codeThemeOptions(),
                disableFileHeader: true,
                enableLineSelection: true,
                enableGutterUtility: true,
                onGutterUtilityClick: (range) => setDraft(orderRange(range)),
                onLineSelectionEnd: (range) => range && setDraft(orderRange(range)),
                onLineEnter: (hovered) => drag.enterLine({ lineNumber: hovered.lineNumber }),
                ...symbols.tokenOptions
              }}
            />
          </Virtualizer>
        )}
        {symbols.hoverCard}
      </div>
    </div>
  )
}
