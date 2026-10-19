import { type DiffLineAnnotation, PatchDiff, Virtualizer } from '@pierre/diffs/react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { type Attachment, commentsPrompt, extractLines, isReviewComment, type LineRange, linesLabel, type ReviewComment } from '../../shared/comments'
import { list } from '../../shared/json'
import type { FilePatch } from '../../shared/types'
import { CommentCard, CommentDraft, orderRange } from './Comments'
import { FolderExplorer } from './Explorer'
import { codeThemeOptions, diffBackground, FileView } from './FileView'
import { HistoryDialog } from './HistoryDialog'
import { FileIcon, Icon } from './Icon'
import type { Navigate } from './codeNavigation'
import { updateSettings, useSettings } from './settings'
import { readStored } from './storage'
import { withKeys, actionKeys } from '../../shared/keymap'
import { EmptyState, FoldAllButton, IconButton, ResizeHandle, useActionKeys, usePersisted } from './ui'

const COMMENTS_KEY = 'comments'
// ponytail: polls while the panel is open; a file watcher if agents ever edit faster than a glance
const REFRESH_MS = 5000
/** Patches this long start folded, so one lockfile doesn't bury the rest */
const FOLDED_LINES = 400

let comments: ReviewComment[] = list(readStored(COMMENTS_KEY), isReviewComment)
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const getComments = (): ReviewComment[] => comments
export function setComments(next: ReviewComment[]): void {
  comments = next
  localStorage.setItem(COMMENTS_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}
export const useComments = (): ReviewComment[] => useSyncExternalStore(subscribe, getComments)
export const addComment = (comment: ReviewComment): void => setComments([...comments, comment])
export const updateComment = (next: ReviewComment): void => setComments(comments.map((comment) => (comment.id === next.id ? next : comment)))
export const deleteComment = (comment: ReviewComment): void => setComments(comments.filter((candidate) => candidate.id !== comment.id))
export const clearComments = (worktreePath: string): void => setComments(comments.filter((comment) => comment.worktreePath !== worktreePath))

/** Hands a checkout's comments to the chat's composer and drops them, as the old shell pasted them into a terminal */
export function SendComments({ worktreePath, send }: { worktreePath: string; send: ((prompt: string) => void) | null }): React.JSX.Element | null {
  const own = useComments().filter((comment) => comment.worktreePath === worktreePath)
  if (!send || !own.length) return null
  return (
    <button
      onClick={() => {
        send(commentsPrompt(own, worktreePath))
        clearComments(worktreePath)
      }}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-2.5 text-xs text-background hover:opacity-90"
    >
      <Icon name="comment" className="size-3" />
      Send {own.length} to chat
    </button>
  )
}

/** A file in the right panel: editable with autosave, commentable, with its local edit history */
export function HostFileView({ worktreePath, path, line, onNavigate }: { worktreePath: string; path: string; line: number | null; onNavigate: Navigate }): React.JSX.Element {
  const own = useComments().filter((comment) => comment.worktreePath === worktreePath && comment.kind === 'file' && comment.filePath === path)
  const [history, setHistory] = useState(false)
  const [version, setVersion] = useState(0)
  return (
    <>
      <FileView
        key={`${path}:${line}:${version}`}
        worktreePath={worktreePath}
        path={path}
        line={line}
        comments={own}
        onNavigate={onNavigate}
        onDeleteComment={deleteComment}
        onSaved={() => undefined}
        onShowHistory={() => setHistory(true)}
        onAddComment={(range, code, text, attachments) => addComment({ id: crypto.randomUUID(), worktreePath, filePath: path, range, code, text, attachments, kind: 'file' })}
      />
      {history && <HistoryDialog worktreePath={worktreePath} path={path} onRestored={() => setVersion(version + 1)} onClose={() => setHistory(false)} />}
    </>
  )
}

const annotationSide = (range: LineRange): 'deletions' | 'additions' => range.endSide ?? range.side ?? 'additions'
const samePatches = (a: FilePatch[], b: FilePatch[]): boolean => a.length === b.length && a.every((patch, index) => patch.patch === b[index].patch)

/** What the folder changed against HEAD, untracked files included, every file stacked like Claude Desktop shows a turn's edits */
export function Changes({
  folder,
  onOpen,
  send
}: {
  folder: string
  onOpen: (path: string, line: number | null) => void
  send: ((prompt: string) => void) | null
}): React.JSX.Element {
  'use no memo' // diff colors and code themes are read from settings during render
  const { diffStyle } = useSettings()
  const [patches, setPatches] = useState<FilePatch[] | null>(null)
  const [error, setError] = useState('')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<{ path: string; range: LineRange } | null>(null)
  const [explorer, setExplorer] = usePersisted<boolean>('changes.explorer', false)
  const [explorerWidth, setExplorerWidth] = usePersisted<number>('changes.explorerWidth', 220)
  const changed = useMemo(() => new Set(patches?.map((patch) => patch.path)), [patches])
  const all = useComments().filter((comment) => comment.worktreePath === folder && !comment.kind)

  useEffect(() => {
    let live = true
    const load = (): void =>
      void window.api.diff(folder).then(
        (next) => {
          if (!live) return
          setError('')
          setPatches((current) => {
            if (current && samePatches(current, next)) return current
            if (!current) setFolded(new Set(next.filter((patch) => patch.patch.split('\n').length > FOLDED_LINES).map((patch) => patch.path)))
            return next
          })
        },
        (reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason))
      )
    load()
    const timer = setInterval(load, REFRESH_MS)
    window.addEventListener('focus', load)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [folder])

  const toggle = (path: string): void => {
    const next = new Set(folded)
    if (!next.delete(path)) next.add(path)
    setFolded(next)
  }
  const save = (patch: FilePatch, text: string, attachments: Attachment[]): void => {
    if (!draft) return
    addComment({ id: crypto.randomUUID(), worktreePath: folder, filePath: patch.path, range: draft.range, code: extractLines(patch.patch, draft.range), text, attachments })
    setDraft(null)
  }
  const anyOpen = patches?.some((patch) => !folded.has(patch.path)) ?? false
  const foldAll = (): void => setFolded(anyOpen && patches ? new Set(patches.map((patch) => patch.path)) : new Set())
  const toggleDiffStyle = (): void => updateSettings({ diffStyle: diffStyle === 'split' ? 'unified' : 'split' })
  useActionKeys({ 'changes.foldAll': foldAll, 'changes.diffStyle': toggleDiffStyle })
  const added = patches?.reduce((sum, patch) => sum + patch.additions, 0) ?? 0
  const removed = patches?.reduce((sum, patch) => sum + patch.deletions, 0) ?? 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        {patches && (
          <span className="font-mono tabular-nums">
            {patches.length} {patches.length === 1 ? 'file' : 'files'} <span className="text-emerald-400">+{added}</span> <span className="text-red-400">-{removed}</span>
          </span>
        )}
        <span className="flex-1" />
        <SendComments worktreePath={folder} send={send} />
        {patches && patches.length > 1 && <FoldAllButton anyOpen={anyOpen} groups="files" shortcut={actionKeys('changes.foldAll')} onClick={foldAll} />}
        <IconButton label={withKeys(diffStyle === 'split' ? 'Unified diff' : 'Split diff', 'changes.diffStyle')} onClick={toggleDiffStyle}>
          <Icon name={diffStyle === 'split' ? 'list' : 'splitRight'} />
        </IconButton>
        <IconButton label={explorer ? 'Hide files' : 'Show files'} active={explorer} onClick={() => setExplorer(!explorer)}>
          <Icon name="folder" />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        {explorer && (
          <nav style={{ width: explorerWidth }} className="relative flex shrink-0 flex-col border-r border-border">
            <FolderExplorer root={folder} activePath={null} changed={changed} onOpen={(path) => onOpen(path, null)} />
            <ResizeHandle onResize={setExplorerWidth} />
          </nav>
        )}
        {error ? (
          <EmptyState fill icon="branch" title={error} />
        ) : !patches ? (
          <EmptyState fill title="Loading…" />
        ) : !patches.length ? (
          <EmptyState fill icon="check" title="No changes" />
        ) : (
          // Only the diffs near the viewport render, so a few hundred files and a split/unified switch stay fast
          <Virtualizer className="min-w-0 flex-1 overflow-auto select-text">
            {patches.map((patch) => {
              const open = !folded.has(patch.path)
              const fileComments = all.filter((comment) => comment.filePath === patch.path)
              const fileDraft = draft?.path === patch.path ? draft.range : null
              const annotations: DiffLineAnnotation<{ commentId: string | null }>[] = [
                ...fileComments.map((comment) => ({ side: annotationSide(comment.range), lineNumber: comment.range.end, metadata: { commentId: comment.id } })),
                ...(fileDraft ? [{ side: annotationSide(fileDraft), lineNumber: fileDraft.end, metadata: { commentId: null } }] : [])
              ]
              return (
                <section key={patch.path} className="border-b border-border">
                  <header
                    onClick={() => toggle(patch.path)}
                    className="sticky top-0 z-10 flex h-8 cursor-pointer items-center gap-2 bg-background px-3 text-xs hover:bg-accent select-none"
                  >
                    <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
                    <FileIcon path={patch.path} />
                    <span title={patch.path} className="min-w-0 truncate font-mono text-[11.5px]">
                      {patch.path}
                    </span>
                    {fileComments.length > 0 && <Icon name="comment" className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="flex-1" />
                    <span className="shrink-0 font-mono tabular-nums">
                      <span className="text-emerald-400">+{patch.additions}</span> <span className="text-red-400">-{patch.deletions}</span>
                    </span>
                    <IconButton label="Open file" onClick={(event) => (event.stopPropagation(), onOpen(patch.path, null))}>
                      <Icon name="pencil" className="size-3" />
                    </IconButton>
                  </header>
                  {open && (
                    <PatchDiff
                      patch={patch.patch}
                      className="block"
                      style={diffBackground()}
                      lineAnnotations={annotations}
                      selectedLines={fileDraft}
                      renderAnnotation={({ metadata }) => {
                        const comment = fileComments.find((candidate) => candidate.id === metadata.commentId)
                        if (comment) return <CommentCard comment={comment} onDelete={() => deleteComment(comment)} />
                        return fileDraft ? (
                          <CommentDraft
                            label={`Agent comment on ${linesLabel(fileDraft).toLowerCase()}`}
                            onSave={(text, attachments) => save(patch, text, attachments)}
                            onCancel={() => setDraft(null)}
                          />
                        ) : null
                      }}
                      options={{
                        ...codeThemeOptions(),
                        diffStyle,
                        disableFileHeader: true,
                        // Both sides in full, so the lines between hunks can be expanded
                        loadDiffFiles: async ({ name, prevName = name }) => {
                          const [before, after] = await Promise.all([window.api.readHeadFile(folder, prevName), window.api.readFile(folder, name)])
                          if (before === null || after === null) throw new Error(`${name} cannot be expanded`)
                          return { oldFile: { name: prevName, contents: before }, newFile: { name, contents: after } }
                        },
                        enableLineSelection: true,
                        enableGutterUtility: true,
                        onGutterUtilityClick: (range) => setDraft({ path: patch.path, range: orderRange(range) }),
                        onLineSelectionEnd: (range) => range && setDraft({ path: patch.path, range: orderRange(range) })
                      }}
                    />
                  )}
                </section>
              )
            })}
          </Virtualizer>
        )}
      </div>
    </div>
  )
}
