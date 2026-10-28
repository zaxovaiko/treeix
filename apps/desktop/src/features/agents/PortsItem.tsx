import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu, type MenuItem } from '../../panels/common'
import type { SessionPort } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { Ki, statusDot } from '../../shell/model'
import type { ShellView } from '../../shell/Shell'
import { leaves, placeLabel, type Tab } from '../../shell/state'
import { FIcon } from './icons'
import { Pop } from './Pop'
import { refreshPorts, usePorts } from './ports'
import { useSettings } from './settings'
import { openBrowser } from '../browser/open'
import { usd } from './usage'
import '../../styles/agents.css'

const url = (port: number) => `http://localhost:${port}`
const tabOf = (view: ShellView, session: string) => view.ordered.find((t) => leaves(t.root).includes(session))

/** Title bar: a plug that lists the listening ports, and one opens for open, copy, kill and the session behind it */
export function PortsItem({ view }: { view: ShellView }) {
  const settings = useSettings(view.api)
  const ports = usePorts(view.api, !!settings?.features.ports)
  const button = useRef<HTMLButtonElement>(null)
  const [list, setList] = useState<{ x: number; y: number } | null>(null)
  const [open, setOpen] = useState<{ port: SessionPort; anchor: DOMRect } | null>(null)
  const close = useCallback(() => setOpen(null), [])
  const unique = ports.filter((p, i) => ports.findIndex((q) => q.port === p.port) === i).sort((a, b) => a.port - b.port)
  if (!unique.length) return null
  const items: MenuItem[] = unique.map((p) => ({
    label: `:${p.port}${p.command ? ` · ${p.command}` : ''}`,
    run: () => button.current && setOpen({ port: p, anchor: button.current.getBoundingClientRect() }),
  }))
  return (
    <>
      <button
        ref={button}
        className={`icon ${list || open ? 'on' : ''}`}
        title="Ports your sessions listen on"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setList(list ? null : { x: r.right - 240, y: r.bottom + 4 })
        }}
      >
        <FIcon name="plug" />
      </button>
      {list && <Menu at={list} items={items} onClose={() => setList(null)} anchor={button} />}
      {open && <PortMenu view={view} port={open.port} anchor={open.anchor} browser={!!settings?.features.browser} onClose={close} />}
    </>
  )
}

function PortMenu({ view, port, anchor, browser, onClose }: { view: ShellView; port: SessionPort; anchor: DOMRect; browser: boolean; onClose: () => void }) {
  const { api } = view
  const [error, setError] = useState<string | null>(null)
  const session = view.sessions[port.session]
  const tab = tabOf(view, port.session)
  const act = (fn: () => unknown) => () => {
    onClose()
    void fn()
  }
  const kill = () =>
    api.killPort(port.port, port.pid).then(
      () => {
        onClose()
        void refreshPorts(api)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  return (
    <Pop anchor={anchor} className="menu" onClose={onClose}>
      <div className="mlabel">localhost:{port.port}</div>
      {browser && (
        <button className="mi" onClick={act(() => openBrowser(view, `localhost:${port.port}`))}>
          <Icon name="globe" />
          Open in a browser pane
        </button>
      )}
      <button className="mi" onClick={act(() => api.openUrl(url(port.port)))}>
        <FIcon name="link" />
        Open in the default browser
      </button>
      <button className="mi" onClick={act(() => navigator.clipboard.writeText(url(port.port)))}>
        <FIcon name="copy" />
        Copy URL
      </button>
      <button className="mi err" onClick={() => void kill()} title={port.cwd ?? undefined}>
        <Icon name="x" />
        <span className="grow">Kill {port.command ?? 'the process'}</span>
        <span className="d">pid {port.pid}</span>
      </button>
      {error && <div className="uempty err">{error}</div>}
      {session && tab && (
        <>
          <div className="msep" />
          <button className="mi" onClick={act(() => view.dispatch({ type: 'activate', tabId: tab.id }))}>
            <Ki kind={session.kind} dot={statusDot(session.status)} sm />
            <span className="trunc grow">{session.title ?? session.kind}</span>
            <span className="d">{placeLabel(view.placeOfTab(tab))}</span>
          </button>
        </>
      )}
    </Pop>
  )
}

/** Sidebar tab row extras: the ports its panes listen on and what its agents cost so far */
export function TabTags({ view, tab }: { view: ShellView; tab: Tab }) {
  const settings = useSettings(view.api)
  const ports = usePorts(view.api, !!settings?.features.ports)
  const ids = leaves(tab.root)
  const own = [...new Set(ports.filter((p) => ids.includes(p.session)).map((p) => p.port))].sort((a, b) => a - b)
  return (
    <>
      {own.map((port) => (
        <span key={port} className="tag mono">
          :{port}
        </span>
      ))}
      {settings?.features.usage && <AgentCost view={view} ids={ids} />}
    </>
  )
}

function AgentCost({ view, ids }: { view: ShellView; ids: string[] }) {
  const agents = ids.map((id) => view.sessions[id]).filter((s) => s && (s.kind === 'claude' || s.kind === 'codex'))
  // refetch when an agent changes status: a finished turn is when its cost moves
  const key = agents.map((s) => `${s.id}:${s.status}`).join(',')
  const [cost, setCost] = useState<number | null>(null)
  useEffect(() => {
    if (!key) return setCost(null)
    let live = true
    const sessions = key.split(',').map((k) => k.split(':')[0])
    void Promise.all(sessions.map((id) => view.api.sessionUsage(id).catch(() => null))).then((all) => {
      const known = all.flatMap((u) => (u?.costUsd == null ? [] : [u.costUsd]))
      if (live) setCost(known.length ? known.reduce((a, b) => a + b, 0) : null)
    })
    return () => {
      live = false
    }
  }, [view.api, key])
  return cost === null ? null : <span className="num">{usd(cost)}</span>
}
