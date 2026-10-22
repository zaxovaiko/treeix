import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { Monaco } from './setup'
import { gutterRange } from './text'

export interface EditorHandle {
  editor: MonacoEditor.IStandaloneCodeEditor
  monaco: Monaco
}

export interface Zone {
  line: number
  key: string
  node: ReactNode
}

type MountedZone = { id: string; line: number; content: HTMLDivElement; observer: ResizeObserver }

/** Zones live in the scrolling lines layer, as wide as the longest line; cards stay pinned to the visible width */
const fitToViewport = ({ editor }: EditorHandle, content: HTMLDivElement): void => {
  const { contentWidth, verticalScrollbarWidth } = editor.getLayoutInfo()
  content.style.width = `${contentWidth - verticalScrollbarWidth}px`
  content.style.transform = `translateX(${editor.getScrollLeft()}px)`
}

/**
 * React content between lines as view zones, like VS Code's review comments. The + in the glyph margin
 * or a line-number drag asks for a comment on those lines
 */
export function EditorZones({ handle, zones, onGutterComment }: { handle: EditorHandle; zones: Zone[]; onGutterComment: (range: { start: number; end: number }) => void }) {
  const [nodes, setNodes] = useState<Map<string, HTMLDivElement>>(new Map())
  const mounted = useRef(new Map<string, MountedZone>())
  const placement = zones.map((zone) => `${zone.key}@${zone.line}`).join()

  useEffect(() => {
    // Monaco hides its zone layer from screen readers, which would hide the cards' text boxes and buttons too
    handle.editor.getDomNode()?.querySelector('.lines-content > .view-zones')?.removeAttribute('aria-hidden')
    const live = mounted.current
    return () => {
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
        // Keys typed in a card would reach Monaco's keybindings (⌘F find, ⌘K chords)
        domNode.addEventListener('keydown', (event) => event.stopPropagation())
        fitToViewport(handle, content)
        const spec = { afterLineNumber: line, heightInPx: 80, domNode }
        const id = accessor.addZone(spec)
        // Cards grow as text wraps; zones scrolled out of view are display:none and measure 0
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
    const fitAll = () => mounted.current.forEach(({ content }) => fitToViewport(handle, content))
    const subscriptions = [editor.onDidLayoutChange(fitAll), editor.onDidScrollChange(fitAll)]
    return () => subscriptions.forEach((subscription) => subscription.dispose())
  }, [handle])

  useEffect(() => {
    const { editor, monaco } = handle
    const { MouseTargetType } = monaco.editor
    const hover = editor.createDecorationsCollection()
    let hoveredLine: number | undefined
    let fromLineNumbers = false
    const subscriptions = [
      editor.onMouseMove(({ target }) => {
        const onZone = target.type === MouseTargetType.CONTENT_VIEW_ZONE || target.type === MouseTargetType.GUTTER_VIEW_ZONE
        const line = onZone ? undefined : target.position?.lineNumber
        if (line === hoveredLine) return
        hoveredLine = line
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'fv-comment-glyph' } }] : [])
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

  return <>{zones.map((zone) => { const node = nodes.get(zone.key); return node ? createPortal(zone.node, node, zone.key) : null })}</>
}
