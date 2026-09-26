import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LineRange } from '../../../shared/comments'
import type { SymbolTarget } from '../../../shared/types'
import { routeAppChord } from '../actionRunners'
import { type Navigate, openSymbolMenu, setActiveTarget } from '../codeNavigation'
import { copyText, type MenuEntry, openMenu } from '../contextMenu'
import type { CodeEditorHandle } from './CodeEditor'
import { gutterRange } from './text'

const targetAt = (handle: CodeEditorHandle, path: string, position: { lineNumber: number; column: number } | null): SymbolTarget | null => {
  const model = handle.editor.getModel()
  const word = position && model?.getWordAtPosition(position)
  return word && position && model ? { path, line: position.lineNumber, column: word.startColumn - 1, symbol: word.word, text: model.getValue() } : null
}

const selectedText = ({ editor }: CodeEditorHandle): string => {
  const selection = editor.getSelection()
  return selection && !selection.isEmpty() ? (editor.getModel()?.getValueInRange(selection) ?? '') : ''
}

/** ⌘-click goes to the definition, F12 and friends act on the cursor's symbol, right-click opens the symbol menu */
export function useEditorNavigation(handle: CodeEditorHandle | null, worktreePath: string, path: string, onNavigate: Navigate): void {
  // App recreates onNavigate every render; a ref keeps the Monaco listeners from re-subscribing
  const navigate = useRef(onNavigate)
  navigate.current = onNavigate

  useEffect(() => {
    if (!handle) return
    const { editor, monaco } = handle
    const symbolUnder = (target: { type: number; position: { lineNumber: number; column: number } | null }): SymbolTarget | null =>
      target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? targetAt(handle, path, target.position) : null
    // Navigating on mousedown would reveal the definition while Monaco still tracks the drag, so a jitter selects code
    let clicked: SymbolTarget | null = null
    const subscriptions = [
      editor.onDidChangeCursorPosition(({ position }) => {
        const target = targetAt(handle, path, position)
        if (target) setActiveTarget(target, worktreePath)
      }),
      editor.onMouseDown(({ event, target }) => {
        clicked = event.metaKey ? symbolUnder(target) : null
      }),
      editor.onMouseUp(({ event, target }) => {
        const symbol = clicked
        clicked = null
        const released = event.metaKey ? symbolUnder(target) : null
        if (symbol && released?.line === symbol.line && released.column === symbol.column) navigate.current('definition', symbol, worktreePath)
      }),
      editor.onContextMenu(({ event, target }) => {
        const symbol = targetAt(handle, path, target.position)
        const selection = selectedText(handle)
        // Monaco's selection isn't a DOM selection, so openMenu can't offer to copy it by itself
        const copySelection: MenuEntry[] = selection ? [{ label: 'Copy selection', accelerator: 'CmdOrCtrl+C', run: () => copyText(selection) }, null] : []
        if (symbol) openSymbolMenu(event.browserEvent, symbol, worktreePath, path, (...args) => navigate.current(...args), copySelection)
        else if (selection) openMenu(event.browserEvent, copySelection)
      })
    ]
    return () => subscriptions.forEach((subscription) => subscription.dispose())
  }, [handle, worktreePath, path])
}

type MountedZone = { id: string; line: number; content: HTMLDivElement; observer: ResizeObserver }

/** Zones live in the scrolling lines layer, as wide as the longest line; cards stay pinned to the visible width */
const fitToViewport = ({ editor }: CodeEditorHandle, content: HTMLDivElement): void => {
  const { contentWidth, verticalScrollbarWidth } = editor.getLayoutInfo()
  content.style.width = `${contentWidth - verticalScrollbarWidth}px`
  content.style.transform = `translateX(${editor.getScrollLeft()}px)`
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
  const mounted = useRef(new Map<string, MountedZone>())
  const placement = zones.map((zone) => `${zone.key}@${zone.line}`).join()

  useEffect(() => {
    // Monaco hides its zone layer from screen readers, which would hide the cards' text boxes and buttons too
    handle.editor.getDomNode()?.querySelector('.lines-content > .view-zones')?.removeAttribute('aria-hidden')
    const live = mounted.current
    return () => {
      // Outside changeViewZones, which skips its callback when the editor was disposed first
      live.forEach(({ observer }) => observer.disconnect())
      handle.editor.changeViewZones((accessor) => live.forEach(({ id }) => accessor.removeZone(id)))
      live.clear()
    }
  }, [handle])

  // Only zones that appeared, left or moved change; the rest keep their container, so React keeps a draft's typed text
  useEffect(() => {
    const { editor } = handle
    const wanted = new Map(zones.map((zone) => [zone.key, zone.line]))
    editor.changeViewZones((accessor) => {
      for (const [key, zone] of mounted.current) {
        if (wanted.get(key) === zone.line) continue
        zone.observer.disconnect()
        accessor.removeZone(zone.id)
        mounted.current.delete(key)
      }
      for (const [key, line] of wanted) {
        if (mounted.current.has(key)) continue
        const domNode = document.createElement('div')
        const content = document.createElement('div')
        domNode.appendChild(content)
        // Keys typed in a card would reach Monaco's keybindings (⌘K chords, ⌘F find); app chords still get through
        domNode.addEventListener('keydown', (event) => {
          routeAppChord(event)
          event.stopPropagation()
        })
        fitToViewport(handle, content)
        const spec = { afterLineNumber: line, heightInPx: 80, domNode }
        const id = accessor.addZone(spec)
        // Cards grow as text wraps or the draft expands; zones scrolled out of view are display:none and measure 0
        const observer = new ResizeObserver(() => {
          if (!content.offsetHeight) return
          spec.heightInPx = content.offsetHeight + 8
          editor.changeViewZones((layout) => layout.layoutZone(id))
        })
        observer.observe(content)
        mounted.current.set(key, { id, line, content, observer })
      }
    })
    setNodes(new Map([...mounted.current].map(([key, zone]) => [key, zone.content])))
  }, [handle, placement])

  useEffect(() => {
    const { editor } = handle
    const fitAll = (): void => mounted.current.forEach(({ content }) => fitToViewport(handle, content))
    const subscriptions = [editor.onDidLayoutChange(fitAll), editor.onDidScrollChange(fitAll)]
    return () => subscriptions.forEach((subscription) => subscription.dispose())
  }, [handle])

  // + in the glyph margin on the hovered line; a line-number drag comments on the selected lines
  useEffect(() => {
    const { editor, monaco } = handle
    const { MouseTargetType } = monaco.editor
    const hover = editor.createDecorationsCollection()
    let hoveredLine: number | undefined
    let fromLineNumbers = false
    const subscriptions = [
      editor.onMouseMove(({ target }) => {
        const onCard = target.type === MouseTargetType.CONTENT_VIEW_ZONE || target.type === MouseTargetType.GUTTER_VIEW_ZONE
        const line = onCard ? undefined : target.position?.lineNumber
        if (line === hoveredLine) return
        hoveredLine = line
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'code-editor-comment-glyph' } }] : [])
      }),
      editor.onMouseLeave(() => {
        hoveredLine = undefined
        hover.clear()
      }),
      editor.onMouseDown(({ target }) => {
        fromLineNumbers = target.type === MouseTargetType.GUTTER_LINE_NUMBERS
        if (target.type === MouseTargetType.GUTTER_GLYPH_MARGIN) onGutterComment({ start: target.position.lineNumber, end: target.position.lineNumber })
      }),
      editor.onMouseUp(() => {
        const selection = editor.getSelection()
        if (!fromLineNumbers || !selection) return
        fromLineNumbers = false
        onGutterComment(gutterRange(selection))
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
