import { useEffect, useState } from 'react'
import { createBridge, useHost } from '@treeix/sdk'
import type { Attachment } from '@treeix/shared/comments'
import { elementComment } from './comments'
import { clearSelection, useDesign } from './pages'
import { useBrowser } from './tabs'

const bridge = createBridge('browser')
const WIDTH = 260

/** Over the page, under the selected element: the note that becomes a browser comment */
export function DesignPopover(): React.JSX.Element | null {
  const host = useHost()
  const { selection } = useDesign()
  const { activeId, tabs } = useBrowser()
  const [note, setNote] = useState('')
  const [error, setError] = useState(false)
  const stale = !!selection && selection.tabId !== activeId
  // A tab switch or close leaves the selection behind; drop it so it doesn't reappear over the wrong page
  useEffect(() => {
    if (stale) clearSelection()
  }, [stale])
  if (!selection || stale) return null
  const { value, tabId } = selection
  const tab = tabs.find((candidate) => candidate.id === tabId)
  const below = value.rect.y + value.rect.height + 8
  const top = below + 120 > value.viewport.height ? Math.max(8, value.rect.y - 128) : below
  const left = Math.max(8, Math.min(value.rect.x, value.viewport.width - WIDTH - 8))
  const close = (): void => {
    setNote('')
    setError(false)
    clearSelection()
  }
  const add = async (): Promise<void> => {
    if (!note.trim()) return setError(true)
    const shot = tab?.guestId ? await bridge.invoke<Attachment | null>('capture', tab.guestId, value.rect, value.viewport).catch(() => null) : null
    host.addComment(elementComment(value, note.trim(), host.selectedWorktree ?? host.defaultCwd, shot ?? undefined))
    host.flash('Added the element to comments')
    close()
  }
  return (
    <div style={{ position: 'absolute', top, left, width: WIDTH }} className="z-20 rounded-lg border border-border bg-popover p-2 shadow-lg">
      <div className="mb-1.5 truncate font-mono text-[11px] text-muted-foreground" title={value.selector}>
        {value.selector}
      </div>
      <textarea
        autoFocus
        rows={3}
        value={note}
        placeholder="What should change here"
        onChange={(event) => (setNote(event.target.value), setError(false))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey) void add()
          if (event.key === 'Escape') close()
        }}
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
      />
      {error && <div className="mt-1 text-[11px] text-red-400">Write a note first</div>}
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button onClick={close} className="h-6 rounded px-2 text-xs text-muted-foreground hover:bg-accent">
          Cancel
        </button>
        <button onClick={() => void add()} className="h-6 rounded border border-border px-2 text-xs hover:bg-accent">
          Add comment ⌘↵
        </button>
      </div>
    </div>
  )
}
