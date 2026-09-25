import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LineRange } from '../../../shared/comments'
import type { SymbolTarget } from '../../../shared/types'
import { type Navigate, openSymbolMenu, setActiveTarget } from '../codeNavigation'
import type { CodeEditorHandle } from './CodeEditor'

const targetAt = (handle: CodeEditorHandle, path: string, position: { lineNumber: number; column: number } | null): SymbolTarget | null => {
  const word = position && handle.editor.getModel()?.getWordAtPosition(position)
  return word && position ? { path, line: position.lineNumber, column: word.startColumn - 1, symbol: word.word } : null
}

/** ⌘-click goes to the definition, F12 and friends act on the cursor's symbol, right-click opens the symbol menu */
export function useEditorNavigation(handle: CodeEditorHandle | null, worktreePath: string, path: string, onNavigate: Navigate): void {
  // App recreates onNavigate every render; a ref keeps the Monaco listeners from re-subscribing
  const navigate = useRef(onNavigate)
  navigate.current = onNavigate

  useEffect(() => {
    if (!handle) return
    const { editor, monaco } = handle
    const subscriptions = [
      editor.onDidChangeCursorPosition(({ position }) => {
        const target = targetAt(handle, path, position)
        if (target) setActiveTarget(target, worktreePath)
      }),
      editor.onMouseDown(({ event, target }) => {
        if (!event.metaKey || target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return
        const symbol = targetAt(handle, path, target.position)
        if (symbol) navigate.current('definition', symbol, worktreePath)
      }),
      editor.onContextMenu(({ event, target }) => {
        const symbol = targetAt(handle, path, target.position)
        if (symbol) openSymbolMenu(event.browserEvent, symbol, worktreePath, path, (...args) => navigate.current(...args))
      })
    ]
    return () => subscriptions.forEach((subscription) => subscription.dispose())
  }, [handle, worktreePath, path])
}

/** Comment cards and the draft sit between lines as view zones, like VS Code's review comments */
export function EditorComments({
  handle,
  zones,
  onGutterComment
}: {
  handle: CodeEditorHandle
  zones: { line: number; key: string; node: React.ReactNode }[]
  onGutterComment: (range: LineRange) => void
}): React.JSX.Element {
  const [nodes, setNodes] = useState<Map<string, HTMLDivElement>>(new Map())
  const placement = zones.map((zone) => `${zone.key}@${zone.line}`).join()

  useEffect(() => {
    const { editor } = handle
    const created = new Map<string, HTMLDivElement>()
    const ids: string[] = []
    const observers: ResizeObserver[] = []
    editor.changeViewZones((accessor) => {
      for (const zone of zones) {
        const domNode = document.createElement('div')
        const content = document.createElement('div')
        domNode.appendChild(content)
        const spec = { afterLineNumber: zone.line, heightInPx: 80, domNode }
        const id = accessor.addZone(spec)
        ids.push(id)
        created.set(zone.key, content)
        // Cards grow as text wraps or the draft editor expands; the zone follows
        const observer = new ResizeObserver(() => {
          spec.heightInPx = content.offsetHeight + 8
          editor.changeViewZones((layout) => layout.layoutZone(id))
        })
        observer.observe(content)
        observers.push(observer)
      }
    })
    setNodes(created)
    return () => {
      observers.forEach((observer) => observer.disconnect())
      editor.changeViewZones((accessor) => ids.forEach((id) => accessor.removeZone(id)))
    }
  }, [handle, placement])

  // + in the glyph margin on the hovered line; a line-number drag comments on the selected lines
  useEffect(() => {
    const { editor, monaco } = handle
    const hover = editor.createDecorationsCollection()
    let fromLineNumbers = false
    const subscriptions = [
      editor.onMouseMove(({ target }) => {
        const line = target.position?.lineNumber
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'code-editor-comment-glyph' } }] : [])
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown(({ target }) => {
        fromLineNumbers = target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        if (target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) onGutterComment({ start: target.position.lineNumber, end: target.position.lineNumber })
      }),
      editor.onMouseUp(() => {
        const selection = editor.getSelection()
        if (!fromLineNumbers || !selection) return
        fromLineNumbers = false
        // Dragging line numbers selects whole lines; a selection ending at column 1 stops on the line before
        const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber
        onGutterComment({ start: selection.startLineNumber, end })
      })
    ]
    return () => {
      hover.clear()
      subscriptions.forEach((subscription) => subscription.dispose())
    }
  }, [handle, onGutterComment])

  return (
    <>
      {zones.map((zone) => {
        const node = nodes.get(zone.key)
        return node ? createPortal(zone.node, node, zone.key) : null
      })}
    </>
  )
}
