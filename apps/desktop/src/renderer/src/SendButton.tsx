import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shellQuote } from '../../shared/shell'
import type { Repo } from '../../shared/types'
import { Icon } from './Icon'
import { KindBadge, StatusDot, worktreeLabel } from './sessionUi'
import type { SessionSummary as Session } from '@treeix/sdk'
import { useService, useSessions } from './plugins'
import { inWorkspace, useWorkspaces } from './workspaces'
import { usePersisted } from './ui'

const lastTargets = new Map<string, string>()

function defaultTarget(sessions: Session[], worktreePath: string): Session | undefined {
  const alive = sessions.filter((session) => session.status !== 'exited')
  const remembered = alive.find((session) => session.id === lastTargets.get(worktreePath))
  const agents = alive.filter((session) => session.worktreePath === worktreePath && session.kind !== 'shell')
  return remembered ?? agents.find((session) => session.status !== 'input') ?? agents[0]
}

export function SendButton({
  repos,
  worktreePath,
  count,
  prompt,
  variant,
  onDone,
  onClear
}: {
  repos: Repo[] | null
  worktreePath: string
  count: number
  prompt: () => string
  variant: 'pill' | 'panel'
  onDone: (message: string) => void
  onClear?: () => void
}): React.JSX.Element {
  // Only sessions of this workspace, even when another workspace has one on the same checkout
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaces.find((candidate) => candidate.id === currentId)
  const sessions = useSessions().filter((session) => inWorkspace(session, workspace, repos, workspaces))
  const service = useService('sessions')
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  // Placed against the window rather than the button's box, so panels that scroll (like the comments popover) can't cut it off
  const [menuPlace, setMenuPlace] = useState<React.CSSProperties | null>(null)
  const openMenu = (): void => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    const above = rect.top - 16
    const below = window.innerHeight - rect.bottom - 16
    setMenuPlace({
      right: Math.max(8, window.innerWidth - rect.right),
      ...(above >= below ? { bottom: window.innerHeight - rect.top + 8, maxHeight: above } : { top: rect.bottom + 8, maxHeight: below })
    })
    setMenuOpen(true)
  }
  // Off by default so extra context can be typed before sending; a new key so earlier saved choices don't turn it back on
  const [submit, setSubmit] = usePersisted<boolean>('send.submitAfterPaste', false)
  const target = defaultTarget(sessions, worktreePath)
  const label = `${count} comment${count === 1 ? '' : 's'}`

  const send = (session: Session): void => {
    const waiting = session.status === 'input'
    if (waiting && !window.confirm(`${session.title} is waiting for an answer. Paste the comments anyway?`)) return
    lastTargets.set(worktreePath, session.id)
    service?.sendText(session.id, prompt(), submit)
    setMenuOpen(false)
    onDone(`Sent ${label} to ${session.title}`)
  }

  const copy = (): void => {
    navigator.clipboard.writeText(prompt())
    setMenuOpen(false)
    onDone(`Copied ${label}`)
  }

  const startAgent = (kind: 'claude' | 'codex'): void => {
    setMenuOpen(false)
    if (!service) return
    const text = prompt()
    if (submit) {
      // As the opening prompt the comments go straight to the agent
      service.start(worktreePath, kind, shellQuote(text)).then((id) => lastTargets.set(worktreePath, id))
    } else {
      // Pasted into the input once the agent is up, so there is room to add context before pressing Enter
      service.start(worktreePath, kind).then(async (id) => {
        lastTargets.set(worktreePath, id)
        await service.whenReady(id)
        service.sendText(id, text, false)
      })
    }
    onDone(`Started ${kind === 'claude' ? 'Claude' : 'Codex'} with ${label}`)
  }

  const alive = sessions.filter((session) => session.status !== 'exited')
  const here = alive.filter((session) => session.worktreePath === worktreePath)
  const elsewhere = alive.filter((session) => session.worktreePath !== worktreePath && session.kind !== 'shell')

  const row = (session: Session): React.JSX.Element => (
    <button
      key={session.id}
      onClick={() => send(session)}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
    >
      <span className="w-3 text-primary">{session.id === target?.id ? '✓' : ''}</span>
      <KindBadge kind={session.kind} />
      <span className="min-w-0 flex-1 truncate">
        {session.title}
        {session.worktreePath !== worktreePath && (
          <span className="text-muted-foreground"> · {worktreeLabel(repos, session.worktreePath)}</span>
        )}
      </span>
      <StatusDot session={session} withLabel />
    </button>
  )

  const shell =
    variant === 'pill'
      ? 'h-7 rounded-full border border-primary/40 bg-card text-primary shadow-lg shadow-black/40'
      : 'h-8 w-full rounded-md bg-primary text-white'
  const divider = variant === 'pill' ? 'border-primary/30' : 'border-white/25'

  return (
    <div ref={anchor} className={`relative flex items-center text-[11.5px] font-medium ${shell}`}>
      <button
        onClick={() => (target ? send(target) : copy())}
        title={target ? `Paste into ${target.title}` : 'No agent session in this worktree, copies to clipboard'}
        className="flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-[inherit] pr-2 pl-3 whitespace-nowrap hover:bg-white/5"
      >
        {target ? (
          <>
            <span>⤷</span>
            <span className="truncate">
              Send {label} to {target.title}
            </span>
          </>
        ) : (
          <>
            <Icon name="copy" className="size-3" />
            Copy {label}
          </>
        )}
      </button>
      <button
        aria-label="Choose where to send comments"
        onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        className={`flex h-full w-7 items-center justify-center rounded-r-[inherit] border-l hover:bg-white/5 ${divider}`}
      >
        <Icon name="chevron" className="size-3 rotate-90" />
      </button>

      {menuOpen &&
        createPortal(
        <div
          onMouseLeave={() => setMenuOpen(false)}
          style={menuPlace ?? undefined}
          className="fixed z-[60] w-80 overflow-y-auto rounded-lg border border-input bg-popover p-1 font-normal text-foreground"
        >
          {here.length > 0 && <div className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">This worktree</div>}
          {here.map(row)}
          {elsewhere.length > 0 && <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">Other worktrees</div>}
          {elsewhere.map(row)}
          {alive.length > 0 && <div className="my-1 border-t border-border" />}
          {service &&
            (['claude', 'codex'] as const).map((kind) => (
              <button key={kind} onClick={() => startAgent(kind)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
                <span className="w-3" />
                <KindBadge kind={kind} /> New {kind === 'claude' ? 'Claude' : 'Codex'} session with comments
              </button>
            ))}
          <button onClick={copy} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
            <span className="w-3" />
            <Icon name="copy" className="size-3.5 text-muted-foreground" /> Copy to clipboard only
          </button>
          <div className="my-1 border-t border-border" />
          <label className="flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={submit} onChange={() => setSubmit(!submit)} className="accent-primary" />
            Press Enter after pasting
          </label>
          {onClear && (
            <button
              onClick={() => {
                setMenuOpen(false)
                onClear()
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-red-400 hover:bg-accent"
            >
              <span className="w-3" />
              <Icon name="close" className="size-3.5" /> Delete {label}
            </button>
          )}
        </div>,
          document.body
        )}
    </div>
  )
}
