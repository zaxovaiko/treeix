import { useEffect, useRef, useState } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { SAVE_CONFLICT, type Api } from '../../ipc/api'
import { attachLsp } from '../../lib/lsp'
import { applyEditorTheme, ensureLanguage, loadMonaco } from '../../lib/monaco/setup'
import { onMenuItem } from '../../lib/native'
import { applyExternalText, normalizeEol } from '../../lib/monaco/text'
import { languageFor } from '../../lib/monaco/theme'
import { EditorZones, type EditorHandle, type Zone } from '../../lib/monaco/zones'
import { CommentCard, CommentDraft } from './CommentCards'
import { addComment, extractFileLines, linesLabel, type LineRange, type ReviewComment } from './comments'
import { gutterMarks, type GutterMarks } from './gutter'
import { FileIcon } from './icons'
import type { Reveal } from './open'
import { useMode } from './mode'

const AUTOSAVE_DELAY_MS = 800
const MARKS_DELAY_MS = 300
const NO_MARKS: GutterMarks = { added: [], modified: [], removed: [] }

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'failed'

const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))

// The same file can be open in two panes; each needs its own model
let modelCounter = 0

/**
 * A text file in Monaco: autosaves after a pause (⌘S right away), saves against what it last read so a change made
 * elsewhere is never overwritten, and follows disk changes while nothing is unsaved
 */
export function TextFile({
  api,
  root,
  file,
  base,
  reveal,
  diff,
  comments,
  onStatus,
  onCursor
}: {
  api: Api
  root: string
  file: string
  /** Default branch the gutter compares with, like `main`; null outside a repo */
  base: string | null
  reveal: Reveal | null
  diff: boolean
  comments: ReviewComment[]
  onStatus: (status: SaveStatus, error: string | null) => void
  /** 1-based, as Monaco counts */
  onCursor: (line: number, column: number) => void
}) {
  const name = file.split('/').pop() ?? file
  const mode = useMode()
  const host = useRef<HTMLDivElement>(null)
  const [contents, setContents] = useState<string | null | undefined>(undefined)
  /** Gone from disk, e.g. deleted from a terminal while the tab was open */
  const [missing, setMissing] = useState(false)
  const [handle, setHandle] = useState<EditorHandle | null>(null)
  const [draft, setDraft] = useState<LineRange | null>(null)
  /** Disk text that changed underneath unsaved edits; autosave pauses until the user picks a side */
  const [conflict, setConflict] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [baseText, setBaseText] = useState<string | null>(null)
  const [headText, setHeadText] = useState<string | null | undefined>(undefined)
  const [marks, setMarks] = useState<GutterMarks>(NO_MARKS)
  const [peeks, setPeeks] = useState<number[]>([])
  /** Editor text as typed, null while it matches disk */
  const latest = useRef<string | null>(null)
  const onDisk = useRef<string | null>(null)
  const conflictRef = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lsp = useRef<ReturnType<typeof attachLsp> | null>(null)
  const status = (next: SaveStatus, error: string | null = null) => onStatus(next, error)
  const current = () => latest.current ?? onDisk.current ?? ''

  const loadFromDisk = (text: string) => {
    onDisk.current = text
    latest.current = null
    conflictRef.current = null
    setMissing(false)
    setConflict(null)
    setComparing(false)
    status('saved')
    setContents(text)
  }

  /** The file changed on disk: follow it when nothing is unsaved, else ask */
  const checkDisk = async () => {
    const unsaved = latest.current !== null && latest.current !== onDisk.current
    const text = await api.readFile(root, file).catch(() => {
      // Unsaved typing stays on screen; saving it brings the file back
      if (!unsaved) setMissing(true)
      return null
    })
    // Our own saves echo back through the watcher
    if (text === null || text === onDisk.current) return
    setMissing(false)
    if (!unsaved) return loadFromDisk(text)
    clearTimeout(timer.current)
    conflictRef.current = text
    setConflict(text)
    status('pending')
  }

  const flush = () => {
    clearTimeout(timer.current)
    const text = latest.current
    if (text === null || text === onDisk.current || conflictRef.current !== null) return
    status('saving')
    api.saveFile(root, file, text, onDisk.current).then(
      () => {
        onDisk.current = text
        status(latest.current === text ? 'saved' : 'pending')
        lsp.current?.saved()
      },
      (reason: unknown) => {
        const message = errorText(reason)
        if (message.includes(SAVE_CONFLICT)) return void checkDisk()
        status('failed', message)
      }
    )
  }

  const keepMine = () => {
    if (conflictRef.current === null) return
    onDisk.current = conflictRef.current
    conflictRef.current = null
    setConflict(null)
    setComparing(false)
    flush()
  }

  useEffect(() => {
    let stale = false
    status('saved')
    api.readFile(root, file).then(
      (text) => {
        if (stale) return
        onDisk.current = text
        setContents(text)
      },
      () => stale || (setMissing(true), setContents(null))
    )
    const unwatch = api.watchFile(root, file, () => void checkDisk())
    // Closing the tab or switching files saves what was typed
    return () => {
      stale = true
      unwatch()
      flush()
    }
  }, [api, root, file])

  useEffect(() => {
    let stale = false
    setBaseText(null)
    if (base) void api.readFileAt(root, file, `origin/${base}`).then((text) => stale || setBaseText(text))
    return () => void (stale = true)
  }, [api, root, file, base])

  useEffect(() => {
    if (!diff) return
    let stale = false
    void api.readFileAt(root, file, 'HEAD').then((text) => stale || setHeadText(text ?? ''))
    return () => void (stale = true)
  }, [api, root, file, diff])

  // The editor mounts once the text is in; later disk text arrives through the effect below
  const loaded = typeof contents === 'string'
  useEffect(() => {
    if (!loaded) return
    let disposed = false
    let created: MonacoEditor.IStandaloneCodeEditor | null = null
    // ⌘A is a menu item the page never sees as a key (src-tauri/src/menu.rs)
    const stopSelectAll = onMenuItem((id) => id === 'select-all' && created?.hasTextFocus() && created.trigger('menu', 'editor.action.selectAll', null))
    void loadMonaco().then(async (monaco) => {
      const language = languageFor(file)
      await ensureLanguage(language)
      await applyEditorTheme()
      if (disposed || !host.current) return
      const uri = monaco.Uri.file(`${root}/${file}`).with({ query: String(++modelCounter) })
      const model = monaco.editor.createModel(current(), language, uri)
      const editor = monaco.editor.create(host.current, {
        model,
        automaticLayout: true,
        glyphMargin: true,
        lineDecorationsWidth: 10,
        contextmenu: false,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 12.5,
        lineHeight: 19,
        minimap: { enabled: false },
        renderWhitespace: 'none',
        tabSize: 2,
        // The EditContext div doesn't count as a text input for the app's shortcuts; the textarea does
        editContext: false
      })
      created = editor
      lsp.current = attachLsp(api, monaco, model, root, file)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, flush)
      editor.onDidChangeCursorPosition(({ position }) => onCursor(position.lineNumber, position.column))
      editor.onDidChangeModelContent(() => {
        const text = model.getValue()
        const baseline = latest.current ?? onDisk.current
        if (baseline !== null && normalizeEol(text) === normalizeEol(baseline)) return
        latest.current = text
        status('pending')
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS)
      })
      setHandle({ editor, monaco })
    })
    return () => {
      disposed = true
      stopSelectAll()
      const model = created?.getModel()
      lsp.current?.dispose()
      lsp.current = null
      created?.dispose()
      model?.dispose()
      setHandle(null)
    }
  }, [loaded, root, file])

  // Disk text the view accepted arrives as one minimal edit, so undo and the cursor survive
  useEffect(() => {
    const model = handle?.editor.getModel()
    if (!handle || !model || typeof contents !== 'string') return
    const change = applyExternalText(model.getValue(), contents)
    if (!change) return
    const from = model.getPositionAt(change.start)
    const to = model.getPositionAt(change.end)
    model.pushEditOperations([], [{ range: new handle.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: change.text }], () => null)
  }, [handle, contents])

  useEffect(() => {
    if (!handle || !reveal) return
    const { editor, monaco } = handle
    editor.revealLineInCenter(reveal.line)
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column })
    editor.focus()
    const target = editor.createDecorationsCollection([{ range: new monaco.Range(reveal.line, 1, reveal.line, 1), options: { isWholeLine: true, className: 'fv-target' } }])
    return () => target.clear()
  }, [handle, reveal])

  // Gutter vs the base branch, recomputed after a typing pause
  useEffect(() => {
    if (!handle || baseText === null) return setMarks(NO_MARKS)
    const model = handle.editor.getModel()
    if (!model) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const update = () => setMarks(gutterMarks(baseText, model.getValue()))
    update()
    const subscription = model.onDidChangeContent(() => {
      clearTimeout(pending)
      pending = setTimeout(update, MARKS_DELAY_MS)
    })
    return () => (clearTimeout(pending), subscription.dispose())
  }, [handle, baseText])

  useEffect(() => {
    if (!handle) return
    const { editor, monaco } = handle
    const line = (n: number, className: string) => ({ range: new monaco.Range(Math.max(n, 1), 1, Math.max(n, 1), 1), options: { linesDecorationsClassName: className } })
    const decorations = editor.createDecorationsCollection([
      ...marks.added.map((n) => line(n, 'fv-gm add')),
      ...marks.modified.map((n) => line(n, 'fv-gm mod')),
      ...marks.removed.map(({ after }) => line(after, after ? 'fv-gm del' : 'fv-gm del top'))
    ])
    const click = editor.onMouseDown(({ target }) => {
      if (target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return
      const removal = marks.removed.find(({ after }) => Math.max(after, 1) === target.position.lineNumber)
      if (removal) setPeeks((open) => (open.includes(removal.after) ? open.filter((n) => n !== removal.after) : [...open, removal.after]))
    })
    return () => (decorations.clear(), click.dispose())
  }, [handle, marks])

  if (contents === undefined) return <div className="empty fv-fill">Loading...</div>
  if (missing) return <div className="empty fv-fill">{name} no longer exists</div>
  if (contents === null) return <Binary api={api} root={root} file={file} />

  const zones: Zone[] = [
    ...marks.removed
      .filter(({ after }) => peeks.includes(after))
      .map(({ after, lines }) => ({ key: `peek:${after}`, line: after, node: <div className="fv-peek">{lines.map((text, i) => <div key={i}>{text || ' '}</div>)}</div> })),
    ...comments.map((comment) => ({ key: comment.id, line: comment.range.end, node: <CommentCard comment={comment} /> })),
    ...(draft
      ? [
          {
            key: 'draft',
            line: draft.end,
            node: (
              <CommentDraft
                label={`Comment on ${linesLabel(draft).toLowerCase()}`}
                onCancel={() => setDraft(null)}
                onSave={(text) => {
                  addComment({ worktreePath: root, filePath: file, range: draft, code: extractFileLines(current(), draft), text })
                  setDraft(null)
                }}
              />
            )
          }
        ]
      : [])
  ]

  return (
    <div className="fv-body">
      {conflict !== null && (
        <div className="fv-conflict">
          <span className="grow">This file changed on disk while you had unsaved edits. Autosave is paused.</span>
          <button className="btn sm" onClick={() => setComparing(!comparing)}>{comparing ? 'Back to editor' : 'Compare'}</button>
          <button className="btn sm" onClick={() => loadFromDisk(conflict)}>Use disk version</button>
          <button className="btn sm pri" onClick={keepMine}>Keep mine</button>
        </div>
      )}
      {conflict !== null && comparing && <Diff name={file} before={conflict} after={current()} mode={mode} />}
      {diff && !comparing && (headText === undefined ? <div className="empty fv-fill">Loading...</div> : <Diff name={file} before={headText ?? ''} after={current()} mode={mode} />)}
      <div className="fv-editor" hidden={diff || comparing}>
        <div ref={host} className="fv-host" />
        {!handle && <div className="empty fv-fill">Loading editor...</div>}
      </div>
      {handle && <EditorZones handle={handle} zones={zones} onGutterComment={setDraft} />}
    </div>
  )
}

/** The theme paints its own background inline; the pane matches the app's instead */
const DIFF_CSS = ':host, pre { --diffs-dark-bg: var(--background) !important; --diffs-light-bg: var(--background) !important; }'

function Diff({ name, before, after, mode }: { name: string; before: string; after: string; mode: 'dark' | 'light' }) {
  if (normalizeEol(before) === normalizeEol(after)) return <div className="empty fv-fill">No changes against HEAD</div>
  return (
    <div className="fv-diff">
      <MultiFileDiff
        oldFile={{ name, contents: before }}
        newFile={{ name, contents: after }}
        disableWorkerPool
        options={{ theme: { dark: 'pierre-dark', light: 'pierre-light' }, themeType: mode, diffStyle: 'unified', disableFileHeader: true, unsafeCSS: DIFF_CSS }}
      />
    </div>
  )
}

export function Binary({ api, root, file }: { api: Api; root: string; file: string }) {
  return (
    <div className="empty fv-fill">
      <FileIcon name="file" className="fv-big" />
      <div>{file.split('/').pop()} is a binary file.</div>
      <button className="btn sm" onClick={() => void api.openPath(`${root}/${file}`)}>
        <FileIcon name="open" />
        Open with default app
      </button>
    </div>
  )
}
