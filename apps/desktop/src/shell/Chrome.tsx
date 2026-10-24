import { useEffect, useState, type MouseEvent, type PointerEvent } from 'react'
import { PortsItem, TabTags } from '../features/agents/PortsItem'
import { UsagePill } from '../features/agents/UsagePill'
import { RoutineClock, RoutinesHost } from '../features/routines'
import { VoiceTitleItems } from '../features/voice'
import type { Api, Place, ProgressState } from '../ipc/api'
import { Icon } from '../lib/icons'
import { DOT_LABEL, GROUP_COLORS, groupColorKey, Ki, liveCount, placeColor, placeIcon, placeName, tabDot, tabKind, tabTitle, tilde } from './model'
import { keyHint, withHint } from './shortcuts'
import { leaves, placeLabel, SIDEBAR, type Group, type PlaceTabs, type Tab } from './state'
import type { ShellView } from './Shell'
import { copyText, Menu, useContextMenu, type MenuItem } from '../panels/common'

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
          <UsagePill api={view.api} />
          <VoiceTitleItems view={view} />
          <button className="kbar mini" onClick={() => run('palette')} title="Search sessions and commands">
            <Icon name="search" />
            <kbd>{keyHint('palette')}</kbd>
          </button>
          <button className="icon" onClick={() => run('settings')} title={withHint('Settings', 'settings')}>
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
          <button className="icon" onClick={() => dispatch({ type: 'set', patch: { sidebar: !ui.sidebar } })} title={withHint(ui.sidebar ? 'Hide sessions' : 'Show sessions', 'toggle-sidebar')}>
            <Icon name={ui.sidebar ? 'sideClose' : 'sideOpen'} />
          </button>
        )}
      </div>
      <button className="kbar" onClick={() => run('palette')}>
        <Icon name="search" />
        <span>Search sessions and commands</span>
        <kbd>{keyHint('palette')}</kbd>
      </button>
      <div className="tb-r" data-tauri-drag-region>
        <UsagePill api={view.api} />
        <VoiceTitleItems view={view} />
        <button className="icon" onClick={() => run('toggle-theme')} title={ui.theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Icon name={ui.theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon" onClick={() => run('settings')} title={withHint('Settings', 'settings')}>
          <Icon name="gear" />
        </button>
      </div>
    </div>
  )
}

/** Right-click on a tab, in the sidebar or the strip */
const tabMenu = (view: ShellView, tab: Tab): MenuItem[] => [
  { label: 'Split right', icon: 'split', run: () => view.split('row', tab.focus) },
  { label: 'Split down', icon: 'splitDown', run: () => view.split('col', tab.focus) },
  { label: 'Copy folder path', run: () => copyText(view.placeOfTab(tab).path) },
  { label: 'Close tab', icon: 'x', danger: true, run: () => view.closeTab(tab) },
]

function TabRow({ view, tab }: ViewProps & { tab: Tab }) {
  const { ui, sessions, dispatch, closeTab } = view
  const [menu, openMenu] = useContextMenu()
  const dot = tabDot(tab, sessions)
  const panes = leaves(tab.root).length
  const restored = leaves(tab.root).some((id) => sessions[id]?.status === 'restored')
  const progress = useProgress(view.api, leaves(tab.root))
  return (
    <div className={`trow ${tab.id === ui.active ? 'on' : ''}`} onClick={() => dispatch({ type: 'activate', tabId: tab.id })} onContextMenu={openMenu(tabMenu(view, tab))}>
      {menu}
      <Ki kind={tabKind(tab, sessions)} dot={dot} />
      <div className="grow">
        <div className="t1">
          <span className="trunc">{tabTitle(tab, sessions)}</span>
          <RoutineClock view={view} tab={tab} />
        </div>
        <div className="t2">
          <span className={`st-${dot}`}>{DOT_LABEL[dot]}</span>
          {restored && <span className="tag">restored</span>}
          {view.placeOfTab(tab).missing && <span className="tag red">folder missing</span>}
          {panes > 1 && (
            <span className="tag">
              <Icon name="split" />
              {panes}
            </span>
          )}
          {progress && <span className={`tag ${progress.state === 'error' ? 'red' : ''}`}>{progress.percent}%</span>}
          <TabTags view={view} tab={tab} />
        </div>
      </div>
      <button className="icon sm x" onClick={stop(() => closeTab(tab))} title="Close">
        <Icon name="x" />
      </button>
    </div>
  )
}

/** The latest OSC 9;4 progress with a percent among `sessions` */
function useProgress(api: Api, sessions: string[]) {
  const [progress, setProgress] = useState<{ session: string; state: ProgressState; percent: number } | null>(null)
  const key = sessions.join(' ')
  useEffect(
    () =>
      api.onEvent((e) => {
        if (e.type !== 'progress' || !key.split(' ').includes(e.session)) return
        const measured = e.state === 'normal' || e.state === 'paused' || e.state === 'error'
        setProgress((p) => (measured ? e : p?.session === e.session ? null : p))
      }),
    [api, key]
  )
  return progress
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

/** Right-click on a group picks its color */
function useColorMenu(view: ShellView) {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; key: string } | null>(null)
  const open = (key: string) => (e: MouseEvent) => {
    e.preventDefault()
    setMenu({ at: { x: e.clientX, y: e.clientY }, key })
  }
  const items = (key: string): MenuItem[] => [
    ...GROUP_COLORS.map(([label, color]) => ({ label, color, run: () => view.dispatch({ type: 'color', key, color }) })),
    { label: 'Default color', run: () => view.dispatch({ type: 'color', key, color: null }) },
  ]
  return [menu && <Menu at={menu.at} items={items(menu.key)} onClose={() => setMenu(null)} />, open] as const
}

function PlaceRows({ view, entry }: ViewProps & { entry: PlaceTabs }) {
  const { place, tabs } = entry
  const closed = view.ui.collapsed.includes(place.key)
  const [menu, openMenu] = useColorMenu(view)
  return (
    <>
      {menu}
      <div className={`wt ${place.missing ? 'missing' : ''}`} style={{ '--c': placeColor(place, view.ui.colors) }} onClick={() => view.dispatch({ type: 'toggleCollapsed', key: place.key })} onContextMenu={openMenu(place.key)} title="Right-click for a color">
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
  // Its own key: the main checkout's place has the group's, and folds on its own
  const key = groupColorKey(group.key)
  const closed = view.ui.collapsed.includes(key)
  const first = group.places[0].place
  const toggle = () => view.dispatch({ type: 'toggleCollapsed', key })
  const [menu, openMenu] = useColorMenu(view)
  const color = view.ui.colors[key]
  const row = { onClick: toggle, onContextMenu: openMenu(key), style: color ? { '--c': color } : undefined, className: `repo ${color ? 'tinted' : ''}` }
  // Sessions on one branch only sit right under the repo, without a branch row
  if (first.repoRoot && group.places.length > 1)
    return (
      <>
        {menu}
        <div {...row} title="Right-click for a color">
          <Chev closed={closed} />
          <Icon name={closed ? 'folder' : 'folderOpen'} />
          <span className="grow trunc">{first.repoName}</span>
        </div>
        {!closed && group.places.map((entry) => <PlaceRows key={entry.place.key} view={view} entry={entry} />)}
      </>
    )
  const tabs = group.places.flatMap((p) => p.tabs)
  return (
    <>
      {menu}
      <div {...row} title={`${tilde(first.path, view.home)}. Right-click for a color`}>
        <Chev closed={closed} />
        <Icon name={first.kind === 'scratch' ? 'home' : closed ? 'folder' : 'folderOpen'} />
        <span className="grow trunc">{first.kind === 'scratch' ? '~' : (first.repoName ?? first.name)}</span>
        {closed ? <span className="tag">{tabs.length}</span> : !first.repoRoot && <span className="prov local">{first.kind === 'scratch' ? 'Home' : 'Not git'}</span>}
        <PlusHere view={view} place={first} />
      </div>
      {!closed && tabs.map((tab) => <TabRow key={tab.id} view={view} tab={tab} />)}
    </>
  )
}

/** Groups with only the tabs whose title or place matches `query` */
function filterGroups(view: ShellView, query: string): Group[] {
  const q = query.trim().toLowerCase()
  if (!q) return view.groups
  const hit = (tab: Tab) => `${tabTitle(tab, view.sessions)} ${placeLabel(view.placeOfTab(tab))}`.toLowerCase().includes(q)
  return view.groups.flatMap((group) => {
    const places = group.places.flatMap((entry) => {
      const tabs = entry.tabs.filter(hit)
      return tabs.length ? [{ ...entry, tabs }] : []
    })
    return places.length ? [{ ...group, places }] : []
  })
}

export function Sidebar({ view }: ViewProps) {
  const [query, setQuery] = useState('')
  const groups = filterGroups(view, query)
  return (
    <>
      <div className="sh">
        <h3>Sessions</h3>
        <button className="icon sm" onClick={() => view.run('new-shell')} title={withHint('New shell', 'new-shell')}>
          <Icon name="plus" />
        </button>
      </div>
      <label className="filter">
        <Icon name="search" />
        <input placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} spellCheck={false} />
      </label>
      <div className="tree">
        {groups.map((group) => (
          <GroupRows key={group.key} view={view} group={group} />
        ))}
        {!groups.length && <div className="empty">{query.trim() ? 'No sessions match' : 'No sessions yet'}</div>}
      </div>
      <div className="sfoot">
        <button className="btn sm" onClick={() => view.run('open-folder')} title={withHint('Open folder', 'open-folder')}>
          <Icon name="folder" />
          <span className="trunc">Open folder...</span>
        </button>
      </div>
    </>
  )
}

export function SidebarResize({ view }: ViewProps) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    // From the drag distance, not the pointer position, so the edge doesn't jump to the pointer on the first move
    const start = handle.previousElementSibling?.getBoundingClientRect().width ?? SIDEBAR.initial
    const x = e.clientX
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('drag')
    const move = (ev: globalThis.PointerEvent) =>
      view.dispatch({ type: 'set', patch: { sidebarWidth: Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, start + ev.clientX - x))) } })
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
  const [menu, openMenu] = useColorMenu(view)
  const [tabMenuEl, openTabMenu] = useContextMenu()
  return (
    <div className="hstrip">
      {menu}
      {tabMenuEl}
      <div className="hscroll" data-tauri-drag-region>
        {view.groups.flatMap((group) =>
          group.places.map(({ place, tabs }) => {
            const closed = ui.collapsed.includes(place.key)
            return [
              <button key={`c${place.key}`} className="gchip" style={{ '--c': placeColor(place, ui.colors) }} onClick={() => dispatch({ type: 'toggleCollapsed', key: place.key })} onContextMenu={openMenu(place.key)} title={`${tilde(place.path, view.home)}. Right-click for a color`}>
                {placeLabel(place)}
                {closed && <span className="n">{tabs.length}</span>}
              </button>,
              ...(closed
                ? []
                : tabs.map((tab) => (
                    <div key={tab.id} className={`htab ${tab.id === ui.active ? 'on' : ''}`} onClick={() => dispatch({ type: 'activate', tabId: tab.id })} onContextMenu={openTabMenu(tabMenu(view, tab))}>
                      <Ki kind={tabKind(tab, sessions)} dot={tabDot(tab, sessions)} sm />
                      <span className="trunc">{tabTitle(tab, sessions)}</span>
                      <RoutineClock view={view} tab={tab} />
                      {place.missing && <span className="tag red">missing</span>}
                      <button className="icon sm x" onClick={stop(() => closeTab(tab))} title="Close">
                        <Icon name="x" />
                      </button>
                    </div>
                  ))),
              <span key={`s${place.key}`} className="gsep" />,
            ]
          })
        )}
        <button className="icon sm" onClick={() => run('new-shell')} title={withHint('New shell', 'new-shell')}>
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
      <button className="icon sm" onClick={() => view.split('row')} title={withHint('Split right', 'split-right')}>
        <Icon name="split" />
      </button>
      <button className="icon sm" onClick={() => view.split('col')} title={withHint('Split down', 'split-down')}>
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
            <span style={{ color: placeColor(place, view.ui.colors) }}>{placeName(place)}</span>
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
      {!place || place.kind === 'scratch' ? (
        <span className="sb">
          <Icon name="home" />~ · no folder
        </span>
      ) : (
        <span className={`sb ${place.missing ? 'st-err' : ''}`} title={place.missing ? 'This folder no longer exists' : tilde(place.path, view.home)}>
          <Icon name={placeIcon(place)} />
          {placeLabel(place)}
          {place.kind === 'folder' && <span className="dim">· not a git repo</span>}
          {place.kind === 'detached' && <span className="dim">· detached</span>}
          {place.missing && <span>· missing</span>}
        </span>
      )}
      <span className="grow" />
      <PortsItem view={view} />
      {needing.length > 0 && (
        <button className="sb st-need" onClick={() => dispatch({ type: 'activate', tabId: needing[0].id })}>
          {needing.length} need you
        </button>
      )}
      <span className="sb" title="Terminals run in a separate host process, so they survive app restarts and updates">
        <Icon name="host" />
        PTY host · {liveCount(ordered, sessions)} live
      </span>
      <RoutinesHost view={view} />
    </div>
  )
}

export function Welcome({ view }: ViewProps) {
  const { recent } = view.ui
  return (
    <div className="welcome">
      <div className="wbox">
        <h2>Start a session</h2>
        <p className="dim">A session runs in a folder. Git repos get worktrees, diffs and PRs. Any other folder, or ~, is just a terminal.</p>
        <button className="wi" onClick={() => view.newSession('shell', view.home)}>
          <Ki kind="shell" />
          <span>
            <b>Shell in ~</b>
            <span className="dim">No folder, no git</span>
          </span>
          <kbd>{keyHint('new-shell')}</kbd>
        </button>
        <button className="wi" onClick={() => view.newSession('claude', view.home)}>
          <Ki kind="claude" />
          <span>
            <b>Claude in ~</b>
            <span className="dim">Ask anything, no project</span>
          </span>
        </button>
        <button className="wi" onClick={() => view.run('open-folder')}>
          <span className="ki">
            <Icon name="folder" />
          </span>
          <span>
            <b>Open folder...</b>
            <span className="dim">A git repo or any folder</span>
          </span>
          <kbd>{keyHint('open-folder')}</kbd>
        </button>
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
