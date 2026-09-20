import { useEffect, useRef, useState } from 'react'
import { shellQuote } from '../../shared/shell'
import type { Repo } from '../../shared/types'
import { Icon } from './Icon'
import { KindBadge, StatusDot, worktreeLabel } from './sessionUi'
import { agentOr, isAgent, useAgents } from './agents'
import type { SessionKind, SessionSummary as Session } from '@treeix/sdk'
import { useService, useSessions } from './plugins'
import { inWorkspace, useWorkspaces } from './workspaces'
import { Popup, usePersisted } from './ui'

const lastTargets = new Map<string, string>()

function defaultTarget(sessions: Session[], worktreePath: string): Session | undefined {
  const alive = sessions.filter((session) => session.status !== 'exited')
  const remembered = alive.find((session) => session.id === lastTargets.get(worktreePath))
  const agents = alive.filter((session) => session.worktreePath === worktreePath && isAgent(session.kind))
  return remembered ?? agents.find((session) => session.status !== 'input') ?? agents[0]
}

export function SendButton({
  repos,
  worktreePath,
  count,
  prompt,
  variant,
  onDone,
  onClear,
  hotkeys = false
}: {
  repos: Repo[] | null
  worktreePath: string
  count: number
  prompt: () => string
  variant: 'pill' | 'panel'
  onDone: (message: string) => void
  onClear?: () => void
  /** ⌘↵ sends to the default target, t picks another from the menu; for the agent comments drawer */
  hotkeys?: boolean
}): React.JSX.Element {
  // Only sessions of this workspace, even when another workspace has one on the same checkout
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaces.find((candidate) => candidate.id === currentId)
  const sessions = useSessions().filter((session) => inWorkspace(session, workspace, repos, workspaces))
  const service = useService('sessions')
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const openMenu = (): void => setMenuOpen(true)
  // Off by default so extra context can be typed before sending; a new key so earlier saved choices don't turn it back on
  const [submit, setSubmit] = usePersisted<boolean>('send.submitAfterPaste', false)
  const target = defaultTarget(sessions, worktreePath)
  const label = `${count} comment${count === 1 ? '' : 's'}`
  const startable = useAgents().filter((agent) => agent.agent)

  // The picked item unmounts with the menu; focus goes back to the button so the drawer keeps the keys
  const closeMenu = (): void => {
    setMenuOpen(false)
    anchor.current?.querySelector('button')?.focus()
  }

  const send = (session: Session): void => {
    const waiting = session.status === 'input'
    if (waiting && !window.confirm(`${session.title} is waiting for an answer. Paste the comments anyway?`)) return
    lastTargets.set(worktreePath, session.id)
    service?.sendText(session.id, prompt(), submit)
    closeMenu()
    onDone(`Sent ${label} to ${session.title}`)
  }

  const copy = (): void => {
    navigator.clipboard.writeText(prompt())
    closeMenu()
    onDone(`Copied ${label}`)
  }

  const startAgent = (kind: SessionKind): void => {
    closeMenu()
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
    onDone(`Started ${agentOr(kind).label} with ${label}`)
  }

  const sendDefault = (): void => (target ? send(target) : copy())
  const latest = useRef({ sendDefault, openMenu })
  latest.current = { sendDefault, openMenu }
  useEffect(() => {
    if (!hotkeys) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || !anchor.current?.closest('[data-drawer]')?.contains(document.activeElement)) return
      const action = event.metaKey && event.key === 'Enter' ? latest.current.sendDefault : !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 't' ? latest.current.openMenu : null
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeys])
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector('button')?.focus()
  }, [menuOpen])
  /** j k and arrows move between the menu's items, esc closes it; its keys stay inside */
  const onMenuKey = (event: React.KeyboardEvent): void => {
    event.stopPropagation()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
    if (step) {
      event.preventDefault()
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
    }
  }

  const alive = sessions.filter((session) => session.status !== 'exited')
  const here = alive.filter((session) => session.worktreePath === worktreePath)
  const elsewhere = alive.filter((session) => session.worktreePath !== worktreePath && isAgent(session.kind))

  const row = (session: Session): React.JSX.Element => (
    <button
      key={session.id}
      onClick={() => send(session)}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
    >
      <span className="w-3 text-foreground">{session.id === target?.id ? '✓' : ''}</span>
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
        onClick={sendDefault}
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

      {menuOpen && (
        <Popup
          ref={menuRef}
          anchor={anchor}
          align="end"
          onDismiss={closeMenu}
          data-send-menu
          onKeyDown={onMenuKey}
          className="w-80 overflow-y-auto rounded-lg border border-input bg-popover p-1 font-normal text-foreground"
        >
          {here.length > 0 && <div className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">This worktree</div>}
          {here.map(row)}
          {elsewhere.length > 0 && <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">Other worktrees</div>}
          {elsewhere.map(row)}
          {alive.length > 0 && <div className="my-1 border-t border-border" />}
          {service &&
            startable.map((agent) => (
              <button key={agent.id} onClick={() => startAgent(agent.id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
                <span className="w-3" />
                <KindBadge kind={agent.id} /> New {agent.label} session with comments
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
                closeMenu()
                onClear()
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-red-400 hover:bg-accent"
            >
              <span className="w-3" />
              <Icon name="close" className="size-3.5" /> Delete {label}
            </button>
          )}
        </Popup>
      )}
    </div>
  )
}
