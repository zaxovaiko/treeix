import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { settingsNow } from '../features/agents/settings'
import { McpSetup } from '../features/mcp/McpSetup'
import type { Command } from '../lib/paletteSearch'
import type { Ticket } from '../ipc/api'
import { IS_MAC, shortcutsPaused } from '../shell/shortcuts'
import type { ShellView } from '../shell/Shell'
import { FileHistory } from './FileHistory'
import { FindInFiles } from './FindInFiles'
import { NewWorktree } from './NewWorktree'
import { Worktrees } from './Worktrees'
import '../styles/dialogs.css'

export type DialogRequest =
  | { kind: 'newWorktree'; repo?: string; pr?: number; ticket?: Ticket }
  | { kind: 'worktrees'; cleanup?: boolean }
  | { kind: 'find' }
  | { kind: 'fileHistory'; root: string; file: string }
  | { kind: 'mcp' }

export interface Repo {
  path: string
  name: string
}

/** Repos with a tab open, the active one first */
export function reposOf(view: ShellView): Repo[] {
  const places = view.groups.flatMap((g) => g.places.map((p) => p.place))
  if (view.activeTab) places.unshift(view.placeOfTab(view.activeTab))
  const repos = new Map<string, Repo>()
  for (const p of places) if (p.repoRoot && !repos.has(p.repoRoot)) repos.set(p.repoRoot, { path: p.repoRoot, name: p.repoName ?? p.repoRoot })
  return [...repos.values()]
}

/** Activates a tab open in `path`, or opens a session there */
export function goTo(view: ShellView, path: string, kind: 'shell' | 'claude' | 'codex' = 'shell') {
  const tab = view.ordered.find((t) => view.placeOfTab(t).path === path)
  if (tab) view.dispatch({ type: 'activate', tabId: tab.id })
  else view.newSession(kind, path)
}

const hint = (key: string) => (IS_MAC ? `⇧⌘${key}` : `Ctrl+Shift+${key}`)

export const dialogCommands = (view: ShellView): Command[] => [
  { id: 'dlg-new-worktree', group: 'Actions', label: 'Open worktree...', shortcut: hint('N'), icon: 'branch', run: () => view.openDialog({ kind: 'newWorktree' }) },
  { id: 'dlg-find', group: 'Actions', label: 'Find in files', shortcut: hint('F'), icon: 'search', run: () => view.openDialog({ kind: 'find' }) },
  { id: 'dlg-worktrees', group: 'Actions', label: 'Worktrees', icon: 'branch', run: () => view.openDialog({ kind: 'worktrees' }) },
  { id: 'dlg-cleanup', group: 'Actions', label: 'Clean up worktrees...', icon: 'branch', run: () => view.openDialog({ kind: 'worktrees', cleanup: true }) },
  ...(settingsNow()?.features.mcp ? [{ id: 'dlg-mcp', group: 'Actions', label: 'Set up Treeix MCP...', icon: 'gear', run: () => view.openDialog({ kind: 'mcp' }) } satisfies Command] : []),
]

/** ⇧⌘N and ⇧⌘F (Ctrl+Shift on Linux, where a focused terminal keeps Ctrl+Shift+F for its find bar); captured before the terminal sees them */
export function useDialogKeys(open: (request: DialogRequest) => void) {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (shortcutsPaused() || !e.shiftKey || e.altKey || (IS_MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return
    const key = e.key.toLowerCase()
    const inTerminal = !IS_MAC && e.target instanceof Element && e.target.closest('.xterm')
    const request: DialogRequest | null = key === 'n' ? { kind: 'newWorktree' } : key === 'f' && !inTerminal ? { kind: 'find' } : null
    if (!request) return
    e.preventDefault()
    e.stopPropagation()
    open(request)
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
}

export function Dialogs({ view, request, onClose }: { view: ShellView; request: DialogRequest; onClose: () => void }) {
  switch (request.kind) {
    case 'newWorktree':
      return <NewWorktree view={view} request={request} onClose={onClose} />
    case 'worktrees':
      return <Worktrees view={view} cleanup={!!request.cleanup} onClose={onClose} />
    case 'find':
      return <FindInFiles view={view} onClose={onClose} />
    case 'fileHistory':
      return <FileHistory view={view} root={request.root} file={request.file} onClose={onClose} />
    case 'mcp':
      return <McpSetup view={view} onClose={onClose} />
  }
}

/** Scrim plus the box; Escape and a click outside close it unless `busy` */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Tab past either end wraps around inside the dialog */
function trapTab(e: ReactKeyboardEvent, box: HTMLElement) {
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
  const first = items[0]
  const last = items.at(-1)
  const at = document.activeElement
  if (!first || !last) e.preventDefault()
  else if (e.shiftKey && (at === first || at === box)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}

export function Modal({ className = '', busy = false, onClose, children }: { className?: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  // Read at first render, before a child's autoFocus moves it
  const [opener] = useState(() => document.activeElement)
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [opener])
  return (
    <>
      <div className="scrim" onMouseDown={() => !busy && onClose()} />
      <div
        ref={box}
        className={`modal ${className}`}
        role="dialog"
        aria-modal
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && box.current) return trapTab(e, box.current)
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          if (!busy) onClose()
        }}
      >
        {children}
      </div>
    </>
  )
}
