import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { PortsItem, TabTags } from '../features/agents/PortsItem'
import { UsagePill } from '../features/agents/UsagePill'
import { RoutineClock } from '../features/routines'
import { VoiceTitleItems } from '../features/voice'
import { useSettings } from '../features/agents/settings'
import type { Api, KeepAwakeMode, Place, ProgressState } from '../ipc/api'
import { Panels } from '../panels/Panels'
import { LangBadge } from '../panes/file/icons'
import { activeFileOf, isFileLeaf, useFileViews } from '../panes/file/open'
import { Icon } from '../lib/icons'
import { DOT_LABEL, GROUP_COLORS, groupColorKey, Ki, leafKind, leafTitle, liveCount, placeColor, placeIcon, placeName, statusDot, tabDot, tabKind, tabTitle, tilde } from './model'
import { keyHint, withHint } from './shortcuts'
import { leaves, placeLabel, SIDEBAR, type Group, type PlaceTabs, type Tab } from './state'
import type { ShellView } from './Shell'
import { copyText, Menu, PIcon, useContextMenu, type MenuItem } from '../panels/common'

type ViewProps = { view: ShellView }

const stop = (fn: () => void) => (e: { stopPropagation(): void }) => {
  e.stopPropagation()
  fn()
}

const Chev = ({ closed }: { closed: boolean }) => <Icon name="down" className={`chev ${closed ? 'closed' : ''}`} />

/** The only bar: tabs or where the active tab runs, then what the status bar and the side rail used to hold. `hidden` while a page (settings) covers the center */
export function TitleBar({ view, tabbed, hidden }: ViewProps & { tabbed: boolean; hidden: boolean }) {
  const { ui, dispatch, run } = view
  return (
    <div className={`titlebar ${tabbed ? 'tabbed' : ''}`} data-tauri-drag-region>
      <div className="lights" data-tauri-drag-region>
        <i />
        <i />
        <i />
      </div>
      {ui.orientation === 'vertical' && (
        <button className="icon" onClick={() => dispatch({ type: 'set', patch: { sidebar: !ui.sidebar } })} title={withHint(ui.sidebar ? 'Hide sessions' : 'Show sessions', 'toggle-sidebar')}>
          <Icon name={ui.sidebar ? 'sideClose' : 'sideOpen'} />
        </button>
      )}
      {tabbed ? (
        <HStrip view={view} />
      ) : (
        <div className="tb-mid" data-tauri-drag-region>
          {ui.orientation === 'vertical' && <Crumbs view={view} />}
        </div>
      )}
      <div className="tb-r" data-tauri-drag-region>
        <NeedYou view={view} />
        <PortsItem view={view} />
        <UsagePill api={view.api} />
        <VoiceTitleItems view={view} />
        <Panels view={view} hidden={hidden} />
        {view.activeTab && (
          <button className="icon" onClick={() => view.split('row')} title={withHint('Split right', 'split-right')}>
            <Icon name="split" />
          </button>
        )}
        <button className="kbar mini" onClick={() => run('palette')} title="Search sessions and commands">
          <Icon name="search" />
          <kbd>{keyHint('palette')}</kbd>
        </button>
        <MoreButton view={view} />
      </div>
    </div>
  )
}

/** Jumps to the first tab waiting on you */
function NeedYou({ view }: ViewProps) {
  const needing = view.ordered.filter((tab) => tabDot(tab, view.sessions) === 'need')
  if (!needing.length) return null
  return (
    <button className="pill st-need" onClick={() => view.dispatch({ type: 'activate', tabId: needing[0].id })}>
      {needing.length} need you
    </button>
  )
}

const AWAKE_NEXT: Record<KeepAwakeMode, [next: KeepAwakeMode, title: string]> = {
  off: ['untilAgentsFinish', 'Keep awake: off'],
  untilAgentsFinish: ['on', 'Keep awake: while agents work'],
  on: ['off', 'Keep awake: always'],
}

/** ⋯: the folder, the terminal host, keep awake, theme, split down, settings */
function MoreButton({ view }: ViewProps) {
  const { api, ui, activeTab, run } = view
  const settings = useSettings(api)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const place = activeTab && view.placeOfTab(activeTab)
  const mode = settings?.awake.mode
  const items: MenuItem[] = [
    ...(place && place.kind !== 'scratch' ? [{ label: `Copy path: ${tilde(place.path, view.home)}`, icon: placeIcon(place), run: () => copyText(place.path) }] : []),
    { label: `PTY host · ${liveCount(view.ordered, view.sessions)} live`, icon: 'host', run: () => {} },
    ...(settings?.features.awake && mode ? [{ label: AWAKE_NEXT[mode][1], icon: 'coffee' as const, run: () => void api.updateSettings({ awake: { mode: AWAKE_NEXT[mode][0] } }) }] : []),
    { label: 'Language servers', icon: 'code', run: () => view.dispatch({ type: 'set', patch: { panel: 'servers' } }) },
    { label: ui.theme === 'dark' ? 'Light theme' : 'Dark theme', icon: ui.theme === 'dark' ? 'sun' : 'moon', run: () => run('toggle-theme') },
    ...(activeTab ? [{ label: withHint('Split down', 'split-down'), icon: 'splitDown' as const, run: () => view.split('col') }] : []),
    { label: withHint('Settings', 'settings'), icon: 'gear', run: () => run('settings') },
  ]
  return (
    <>
      <button
        className={`icon ${at ? 'on' : ''} ${mode && mode !== 'off' ? `awake-${mode}` : ''}`}
        title="More"
        ref={button}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: r.right - 220, y: r.bottom + 4 })
        }}
      >
        <PIcon name="more" />
      </button>
      {at && <Menu at={at} items={items} onClose={() => setAt(null)} anchor={button} />}
    </>
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
      {panes > 1 ? <SplitIcon /> : <TabIcon view={view} tab={tab} />}
      <div className="grow">
        <div className="t1">
          {panes > 1 ? <SplitSegs view={view} tab={tab} /> : <span className="trunc">{tabTitle(tab, sessions)}</span>}
          <RoutineClock view={view} tab={tab} />
        </div>
        <div className="t2">
          <span className={`st-${dot}`}>{DOT_LABEL[dot]}</span>
          {restored && <span className="tag">restored</span>}
          {view.placeOfTab(tab).missing && <span className="tag red">folder missing</span>}
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

/** A file tab shows its file's language, any other its kind and state */
function TabIcon({ view, tab, sm }: ViewProps & { tab: Tab; sm?: boolean }) {
  const file = isFileLeaf(tab.focus) && activeFileOf(tab.focus)
  return file ? <LangBadge path={file} /> : <Ki kind={tabKind(tab, view.sessions)} dot={tabDot(tab, view.sessions)} sm={sm} />
}

/** One pane of a split: the language of the file it shows, else its kind and status */
function LeafIcon({ view, id }: ViewProps & { id: string }) {
  const file = isFileLeaf(id) && activeFileOf(id)
  const session = view.sessions[id]
  return file ? <LangBadge path={file} /> : <Ki kind={leafKind(id, view.sessions)} dot={session ? statusDot(session.status) : 'idle'} sm />
}

const SplitIcon = ({ sm }: { sm?: boolean }) => (
  <span className={`ki ${sm ? 'sm' : ''}`}>
    <Icon name="split" />
  </span>
)

/** A split tab's row: each pane's session in layout order, the focused one brighter; a click focuses that pane */
function SplitSegs({ view, tab }: ViewProps & { tab: Tab }) {
  return (
    <span className="psegs">
      {leaves(tab.root).map((id) => (
        <button key={id} className={`pseg ${id === tab.focus ? 'on' : ''}`} onClick={stop(() => view.dispatch({ type: 'focus', session: id }))}>
          <LeafIcon view={view} id={id} />
          <span className="trunc">{leafTitle(id, view.sessions)}</span>
        </button>
      ))}
    </span>
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
  useFileViews()
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
export function HStrip({ view }: ViewProps) {
  const { ui, sessions, dispatch, closeTab, run } = view
  const [menu, openMenu] = useColorMenu(view)
  const [tabMenuEl, openTabMenu] = useContextMenu()
  useFileViews()
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
                      {leaves(tab.root).length > 1 ? (
                        <>
                          <SplitIcon sm />
                          <SplitSegs view={view} tab={tab} />
                        </>
                      ) : (
                        <>
                          <TabIcon view={view} tab={tab} sm />
                          <span className="trunc">{tabTitle(tab, sessions)}</span>
                        </>
                      )}
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
    </div>
  )
}

/** Vertical layout: where the active tab runs */
function Crumbs({ view }: ViewProps) {
  const tab = view.activeTab
  if (!tab) return null
  const place = view.placeOfTab(tab)
  return (
    <div className="crumbs" title={place.missing ? 'This folder no longer exists' : tilde(place.path, view.home)}>
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
      {place.missing && <span className="tag red">missing</span>}
      <span className="sep">/</span>
      <b className="trunc">{tabTitle(tab, view.sessions)}</b>
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
