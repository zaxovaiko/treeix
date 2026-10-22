import type { PointerEvent } from 'react'
import type { Place, SessionKind } from '../ipc/api'
import { Icon } from '../lib/icons'
import { DOT_LABEL, Ki, placeColor, placeIcon, placeName, tabDot, tabKind, tabTitle, tilde } from './model'
import { leaves, placeLabel, SIDEBAR, type Group, type PlaceTabs, type Tab } from './state'
import type { ShellView } from './Shell'

type ViewProps = { view: ShellView }

const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
  e.stopPropagation()
  fn()
}

const Chev = ({ closed }: { closed: boolean }) => <Icon name="down" className={`chev ${closed ? 'closed' : ''}`} />

export function TitleBar({ view, tabbed }: ViewProps & { tabbed: boolean }) {
  const { ui, dispatch, run } = view
  const lights = (
    <div className="lights" data-tauri-drag-region>
      <i />
      <i />
      <i />
    </div>
  )
  if (tabbed)
    return (
      <div className="titlebar tabbed" data-tauri-drag-region>
        {lights}
        <HStrip view={view} />
        <div className="tb-r" data-tauri-drag-region>
          <button className="kbar mini" onClick={() => run('palette')} title="Search sessions and commands">
            <Icon name="search" />
            <kbd>⌘K</kbd>
          </button>
          <button className="icon" onClick={() => run('settings')} title="Settings (⌘,)">
            <Icon name="gear" />
          </button>
        </div>
      </div>
    )
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="tb-l" data-tauri-drag-region>
        {lights}
        {ui.orientation === 'vertical' && (
          <button className={`icon ${ui.sidebar ? '' : 'on'}`} onClick={() => dispatch({ type: 'set', patch: { sidebar: !ui.sidebar } })} title="Toggle sessions (⌘\)">
            <Icon name="sideL" />
          </button>
        )}
      </div>
      <button className="kbar" onClick={() => run('palette')}>
        <Icon name="search" />
        <span>Search sessions and commands</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="tb-r" data-tauri-drag-region>
        <button className="icon" onClick={() => run('toggle-theme')} title="Toggle theme">
          <Icon name="moon" />
        </button>
        <button className="icon" onClick={() => run('settings')} title="Settings (⌘,)">
          <Icon name="gear" />
        </button>
      </div>
    </div>
  )
}

function TabRow({ view, tab }: ViewProps & { tab: Tab }) {
  const { ui, sessions, dispatch, closeTab } = view
  const dot = tabDot(tab, sessions)
  const panes = leaves(tab.root).length
  return (
    <div className={`trow ${tab.id === ui.active ? 'on' : ''}`} onClick={() => dispatch({ type: 'activate', tabId: tab.id })}>
      <Ki kind={tabKind(tab, sessions)} dot={dot} />
      <div className="grow">
        <div className="t1">
          <span className="trunc">{tabTitle(tab, sessions)}</span>
        </div>
        <div className="t2">
          <span className={`st-${dot}`}>{DOT_LABEL[dot]}</span>
          {panes > 1 && (
            <span className="tag">
              <Icon name="split" />
              {panes}
            </span>
          )}
        </div>
      </div>
      <button className="icon sm x" onClick={stop(() => closeTab(tab))} title="Close">
        <Icon name="x" />
      </button>
    </div>
  )
}

function PlusHere({ view, place }: ViewProps & { place: Place }) {
  return (
    <span className="acts">
      <button className="icon sm" onClick={stop(() => view.newSession('shell', place.path))} title="New shell here">
        <Icon name="plus" />
      </button>
    </span>
  )
}

function PlaceRows({ view, entry }: ViewProps & { entry: PlaceTabs }) {
  const { place, tabs } = entry
  const closed = view.ui.collapsed.includes(place.key)
  return (
    <>
      <div className={`wt ${place.missing ? 'missing' : ''}`} style={{ '--c': placeColor(place) }} onClick={() => view.dispatch({ type: 'toggleCollapsed', key: place.key })}>
        <Chev closed={closed} />
        <span className="wic">
          <Icon name={placeIcon(place)} />
        </span>
        <span className="grow trunc">{placeName(place)}</span>
        <span className="meta">
          {place.kind === 'detached' && <span className="tag">detached</span>}
          {closed && <span className="tag">{tabs.length}</span>}
        </span>
        <PlusHere view={view} place={place} />
      </div>
      {!closed && tabs.map((tab) => <TabRow key={tab.id} view={view} tab={tab} />)}
    </>
  )
}

function GroupRows({ view, group }: ViewProps & { group: Group }) {
  const closed = view.ui.collapsed.includes(group.key)
  const first = group.places[0].place
  const toggle = () => view.dispatch({ type: 'toggleCollapsed', key: group.key })
  if (first.repoRoot)
    return (
      <>
        <div className="repo" onClick={toggle}>
          <Chev closed={closed} />
          <Icon name="folder" />
          <span className="grow trunc">{first.repoName}</span>
        </div>
        {!closed && group.places.map((entry) => <PlaceRows key={entry.place.key} view={view} entry={entry} />)}
      </>
    )
  const tabs = group.places.flatMap((p) => p.tabs)
  return (
    <>
      <div className="repo" onClick={toggle} title={tilde(first.path, view.home)}>
        <Chev closed={closed} />
        <Icon name={first.kind === 'scratch' ? 'home' : 'folder'} />
        <span className="grow trunc">{first.kind === 'scratch' ? '~' : first.name}</span>
        {closed ? <span className="tag">{tabs.length}</span> : <span className="prov local">{first.kind === 'scratch' ? 'Home' : 'Not git'}</span>}
        <PlusHere view={view} place={first} />
      </div>
      {!closed && tabs.map((tab) => <TabRow key={tab.id} view={view} tab={tab} />)}
    </>
  )
}

export function Sidebar({ view }: ViewProps) {
  return (
    <>
      <div className="sh">
        <h3>Sessions</h3>
        <button className="icon sm" onClick={() => view.run('new-shell')} title="New shell (⌘T)">
          <Icon name="plus" />
        </button>
      </div>
      <div className="tree">
        {view.groups.map((group) => (
          <GroupRows key={group.key} view={view} group={group} />
        ))}
      </div>
    </>
  )
}

export function SidebarResize({ view }: ViewProps) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    const left = handle.previousElementSibling?.getBoundingClientRect().left ?? 0
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('drag')
    const move = (ev: globalThis.PointerEvent) =>
      view.dispatch({ type: 'set', patch: { sidebarWidth: Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, ev.clientX - left))) } })
    const up = () => {
      handle.classList.remove('drag')
      handle.removeEventListener('pointermove', move)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
  }
  return <div className="vsz" onPointerDown={onPointerDown} onDoubleClick={() => view.dispatch({ type: 'set', patch: { sidebarWidth: SIDEBAR.initial } })} />
}

/** Horizontal tabs: a colored chip per place, then its tabs */
export function HStrip({ view, actions }: ViewProps & { actions?: boolean }) {
  const { ui, sessions, dispatch, closeTab, run } = view
  return (
    <div className="hstrip">
      <div className="hscroll" data-tauri-drag-region>
        {view.groups.flatMap((group) =>
          group.places.map(({ place, tabs }) => {
            const closed = ui.collapsed.includes(place.key)
            return [
              <button key={`c${place.key}`} className="gchip" style={{ '--c': placeColor(place) }} onClick={() => dispatch({ type: 'toggleCollapsed', key: place.key })} title={tilde(place.path, view.home)}>
                {placeLabel(place)}
                {closed && <span className="n">{tabs.length}</span>}
              </button>,
              ...(closed
                ? []
                : tabs.map((tab) => (
                    <div key={tab.id} className={`htab ${tab.id === ui.active ? 'on' : ''}`} onClick={() => dispatch({ type: 'activate', tabId: tab.id })}>
                      <Ki kind={tabKind(tab, sessions)} dot={tabDot(tab, sessions)} sm />
                      <span className="trunc">{tabTitle(tab, sessions)}</span>
                      <button className="icon sm x" onClick={stop(() => closeTab(tab))} title="Close">
                        <Icon name="x" />
                      </button>
                    </div>
                  ))),
              <span key={`s${place.key}`} className="gsep" />,
            ]
          })
        )}
        <button className="icon sm" onClick={() => run('new-shell')} title="New shell (⌘T)">
          <Icon name="plus" />
        </button>
      </div>
      {actions && <SplitActions view={view} />}
    </div>
  )
}

function SplitActions({ view }: ViewProps) {
  return (
    <div className="tacts">
      <button className="icon sm" onClick={() => view.split('row')} title="Split right (⌘D)">
        <Icon name="split" />
      </button>
      <button className="icon sm" onClick={() => view.split('col')} title="Split down (⇧⌘D)">
        <Icon name="splitDown" />
      </button>
    </div>
  )
}

/** Vertical layout: where the active tab runs, and its split buttons */
export function CenterTop({ view }: ViewProps) {
  const tab = view.activeTab
  if (!tab) return null
  const place = view.placeOfTab(tab)
  return (
    <div className="ctop">
      <div className="crumbs">
        <Ki kind={tabKind(tab, view.sessions)} dot={tabDot(tab, view.sessions)} sm />
        {place.repoName && place.kind !== 'folder' ? (
          <>
            <span className="dim">{place.repoName}</span>
            <span className="sep">/</span>
            <span style={{ color: placeColor(place) }}>{placeName(place)}</span>
          </>
        ) : (
          <span className="dim">{tilde(place.path, view.home)}</span>
        )}
        <span className="sep">/</span>
        <b className="trunc">{tabTitle(tab, view.sessions)}</b>
      </div>
      <SplitActions view={view} />
    </div>
  )
}

export function StatusBar({ view }: ViewProps) {
  const { activeTab, sessions, ordered, dispatch } = view
  const place = activeTab && view.placeOfTab(activeTab)
  const needing = ordered.filter((tab) => tabDot(tab, sessions) === 'need')
  return (
    <div className="statusbar">
      {place && (
        <span className="sb">
          <Icon name={placeIcon(place)} />
          {placeLabel(place)}
          {place.kind === 'detached' && <span className="dim">detached</span>}
        </span>
      )}
      <span className="grow" />
      {needing.length > 0 && (
        <button className="sb st-need" onClick={() => dispatch({ type: 'activate', tabId: needing[0].id })}>
          {needing.length} need you
        </button>
      )}
      <span className="sb" title="Terminals run in a separate host process, so they survive app restarts and updates">
        <Icon name="host" />
        {Object.keys(sessions).length} sessions
      </span>
    </div>
  )
}

const STARTERS: [SessionKind, string][] = [
  ['shell', 'New shell'],
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
]

export function Welcome({ view }: ViewProps) {
  const recent = view.ui.recent
  return (
    <div className="welcome">
      <div className="wbox">
        <h2>Welcome to Treeix</h2>
        <p className="dim">Terminals keep running when the window closes. Start one in your home folder, or pick up where you left off.</p>
        {STARTERS.map(([kind, label]) => (
          <button key={kind} className="wi" onClick={() => view.newSession(kind, view.home)}>
            <Ki kind={kind} />
            <span>
              <b>{label}</b>
              <span className="dim">in ~</span>
            </span>
            {kind === 'shell' && <kbd>⌘T</kbd>}
          </button>
        ))}
        {recent.length > 0 && <div className="mlabel">Recent places</div>}
        {recent.map((place) => (
          <button key={place.path} className="wi" onClick={() => view.newSession('shell', place.path)}>
            <span className="ki">
              <Icon name={place.kind === 'worktree' || place.kind === 'detached' ? 'branch' : 'folder'} />
            </span>
            <span>
              <b>{place.name}</b>
              <span className="dim mono">{tilde(place.path, view.home)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function Settings({ onClose }: { onClose: () => void }) {
  return (
    <div className="welcome">
      <div className="wbox">
        <h2>Settings</h2>
        <p className="dim">Not here yet. Theme, Compact or Islands, and tab position are in the command palette (⌘K).</p>
        <button className="wi" onClick={onClose}>
          <span className="ki">
            <Icon name="left" />
          </span>
          <span>
            <b>Back to terminals</b>
          </span>
          <kbd>⌘W</kbd>
        </button>
      </div>
    </div>
  )
}
