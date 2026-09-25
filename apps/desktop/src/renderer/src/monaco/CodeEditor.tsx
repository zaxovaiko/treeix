import type { editor as MonacoEditor } from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import { runAction, runnableActionFor } from '../actionRunners'
import { fontStack, getSettings, MONO_STACK, useSettings } from '../settings'
import { EmptyState } from '../ui'
import { applyEditorTheme, ensureLanguage, loadMonaco, type Monaco } from './setup'
import { applyExternalText } from './text'
import { languageFor } from './theme'

export type CodeEditorHandle = { editor: MonacoEditor.IStandaloneCodeEditor; monaco: Monaco }

export function CodeEditor({
  worktreePath,
  path,
  contents,
  line,
  onChange,
  onReady
}: {
  worktreePath: string
  path: string
  contents: string
  line: number | null
  onChange: (text: string) => void
  onReady?: (handle: CodeEditorHandle) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<CodeEditorHandle | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const settings = useSettings()

  useEffect(() => {
    let disposed = false
    let created: MonacoEditor.IStandaloneCodeEditor | null = null
    void loadMonaco().then(async (monaco) => {
      const language = languageFor(path)
      await ensureLanguage(monaco, language)
      if (disposed || !host.current) return
      applyEditorTheme(monaco)
      const uri = monaco.Uri.file(`${worktreePath}/${path}`)
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(contents, language, uri)
      created = monaco.editor.create(host.current, {
        model,
        automaticLayout: true,
        fontFamily: fontStack(getSettings().editorFont, MONO_STACK),
        fontSize: getSettings().editorFontSize,
        glyphMargin: true,
        contextmenu: false,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggest: { showStatusBar: true, preview: true },
        tabSize: 2
      })
      created.onKeyDown((event) => {
        const id = runnableActionFor(event.browserEvent)
        // ⌘/ stays with Monaco's own toggle-line-comment, like VS Code; every other app chord (palette, leader, tab digits) reaches the app instead of Monaco's chords and find-next
        if (!id || id === 'app.shortcuts') return
        event.preventDefault()
        event.stopPropagation()
        runAction(id)
      })
      created.onDidChangeModelContent(() => onChangeRef.current(model.getValue()))
      const next = { editor: created, monaco }
      setHandle(next)
      onReady?.(next)
    })
    return () => {
      disposed = true
      const model = created?.getModel()
      created?.dispose()
      model?.dispose()
      window.api.closeDocument(worktreePath, path)
    }
  }, [worktreePath, path])

  // Disk changes FileView accepted (no unsaved edits) arrive as new contents
  useEffect(() => {
    const model = handle?.editor.getModel()
    if (!handle || !model) return
    const change = applyExternalText(model.getValue(), contents)
    if (!change) return
    const from = model.getPositionAt(change.start)
    const to = model.getPositionAt(change.end)
    model.pushEditOperations(
      [],
      [{ range: new handle.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: change.text }],
      () => null
    )
  }, [handle, contents])

  useEffect(() => {
    if (!handle || !line) return
    handle.editor.revealLineInCenter(line)
    handle.editor.setPosition({ lineNumber: line, column: 1 })
    const decorations = handle.editor.createDecorationsCollection([
      { range: new handle.monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'code-editor-target-line' } }
    ])
    return () => decorations.clear()
  }, [handle, line])

  useEffect(() => {
    if (!handle) return
    applyEditorTheme(handle.monaco)
    handle.editor.updateOptions({ fontFamily: fontStack(settings.editorFont, MONO_STACK), fontSize: settings.editorFontSize })
  }, [handle, settings.theme, settings.opacity, settings.editorFont, settings.editorFontSize])

  return (
    <div className="code-editor relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0" />
      {!handle && <EmptyState fill title="Loading editor..." />}
    </div>
  )
}
