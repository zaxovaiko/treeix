import { useEffect, useEffectEvent, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react'
import type { GitStatus, PullRequest } from '../ipc/api'
import { useSettings } from '../features/agents/settings'
import { compact } from '../features/agents/usage'
import { fallbackPlace } from '../shell/model'
import { shortcutsPaused, withHint } from '../shell/shortcuts'
import { PANEL, type PanelId } from '../shell/state'
import type { ShellView } from '../shell/Shell'
import { Changes } from './Changes'
import { PIcon, type PanelIconName } from './common'
import { Explorer } from './Explorer'
import { History } from './History'
import { Problems, Servers } from './Lsp'
import { needsYou } from './logic'
import { Prs, type PrData } from './Prs'
import { Tickets } from './Tickets'
import { useTickets } from '../features/tickets/useTickets'
import '../styles/panels.css'

const PR_REFRESH_MS = 60_000

const ITEMS: [PanelId, PanelIconName | 'folder' | 'branch' | 'jira', string][] = [
  ['explorer', 'folder', 'Explorer (⇧⌘E)'],
  ['changes', 'branch', 'Changes (⌃⇧G)'],
  ['prs', 'pr', 'Pull requests'],
  ['history', 'history', 'Session history'],
  ['tickets', 'jira', 'Your tickets'],
]

/** ⇧⌘E and ⌃⇧G; matched on `code` so the layout doesn't matter */
const panelKey = (e: KeyboardEvent): PanelId | null =>
  e.code === 'KeyE' && e.shiftKey && e.metaKey && !e.ctrlKey && !e.altKey ? 'explorer' : e.code === 'KeyG' && e.shiftKey && e.ctrlKey && !e.metaKey && !e.altKey ? 'changes' : null

/** Panel icons in the title bar, the open one as a sheet over the terminals; `hidden` while a page (settings) covers the center */
export function Panels({ view, hidden }: { view: ShellView; hidden: boolean }) {
  const { api, ui, dispatch, activeTab, home } = view
  const place = activeTab ? view.placeOfTab(activeTab) : fallbackPlace(home, home)
  const root = place.path
  const scratch = place.kind === 'scratch'
  const settings = useSettings(api)
  const features = settings?.features
  const graph = features?.graph ?? false
  const prsOn = features?.prs ?? true
  const ticketsOn = !!(features?.jira || features?.notion)
  const off = (id: PanelId | null) => (id === 'prs' && !prsOn) || (id === 'tickets' && !ticketsOn)
  const shown = hidden || off(ui.panel) ? null : ui.panel
  const tickets = useTickets(api, ticketsOn && shown === 'tickets' ? settings : null)

  // Git status and file changes of the focused place: one watcher feeds every panel and the badge
  const [git, setGit] = useState<{ root: string; status: GitStatus | null }>({ root: '', status: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (scratch) return
    let live = true
    const load = () => void api.gitStatus(root).then((status) => live && setGit({ root, status }), () => live && setGit({ root, status: null }))
    load()
    const stop = api.watchPlace(root, () => {
      load()
      setTick((n) => n + 1)
    })
    return () => {
      live = false
      stop()
    }
  }, [api, root, scratch])
  const status = git.root === root && !scratch ? git.status : null

  // PRs of every repo in the sidebar or the recent list
  const repoKey = [...new Set([...view.groups.flatMap((g) => g.places.flatMap((p) => p.place.repoRoot ?? [])), ...ui.recent.filter((r) => r.kind === 'root' || r.kind === 'git').map((r) => r.path)])].sort().join('\n')
  const [prs, setPrs] = useState<Omit<PrData, 'refresh'>>({ list: [], errors: [], offline: false, providers: [], worktrees: {} })
  /** Bumped by the refresh button, window focus and the timer */
  const [prTick, setPrTick] = useState(0)
  useEffect(() => {
    if (!prsOn) return
    let live = true
    const repos = repoKey ? repoKey.split('\n') : []
    void Promise.all([api.listPullRequests(repos), api.prProviders(), Promise.all(repos.map((r) => api.listWorktrees(r).catch(() => [])))]).then(
      ([list, providers, worktrees]) =>
        live && setPrs({ list: list.pullRequests, errors: list.errors, offline: false, providers, worktrees: Object.fromEntries(repos.map((r, i) => [r, worktrees[i]])) }),
      () => live && setPrs((last) => ({ ...last, offline: true })),
    )
    return () => void (live = false)
  }, [api, repoKey, prTick, prsOn])
  const refreshPrs = () => setPrTick((n) => n + 1)
  useEffect(() => {
    window.addEventListener('focus', refreshPrs)
    return () => window.removeEventListener('focus', refreshPrs)
  }, [])
  useEffect(() => {
    if (shown !== 'prs') return
    const timer = setInterval(() => document.visibilityState === 'visible' && refreshPrs(), PR_REFRESH_MS)
    return () => clearInterval(timer)
  }, [shown])

  const toggle = (id: PanelId) => {
    if (hidden) view.run('close-pane')
    dispatch({ type: 'set', patch: { panel: ui.panel === id && !hidden ? null : id } })
  }
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const id = panelKey(e)
    if (!id || off(id) || shortcutsPaused()) return
    e.preventDefault()
    e.stopPropagation()
    toggle(id)
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Only the focused project's PRs; a place outside any repo shows them all
  const ofProject = (repoPath: string) => !place.repoRoot || repoPath === place.repoRoot
  const prList = prs.list.filter((pr) => ofProject(pr.repoPath))
  const userOf = (pr: PullRequest) => prs.providers.find((p) => p.provider === pr.provider)?.user ?? null
  const badges: Partial<Record<PanelId, number>> = { changes: status?.changes.length ?? 0, prs: prList.filter((pr) => needsYou(pr, userOf(pr))).length }
  const data: PrData = { ...prs, list: prList, errors: prs.errors.filter((e) => ofProject(e.repoPath)), refresh: refreshPrs }
  const openPanel = (id: PanelId) => dispatch({ type: 'set', patch: { panel: id } })

  const bar = (
    <div className="actbar">
      {ITEMS.filter(([id]) => !off(id)).map(([id, icon, tip]) => (
        <button key={id} className={`icon ${shown === id ? 'on' : ''}`} onClick={() => toggle(id)} title={id === 'prs' && badges.prs ? `${tip}: ${badges.prs} waiting on you` : tip}>
          <PIcon name={icon === 'folder' && shown === id ? 'folderOpen' : icon} />
          {!!badges[id] && <span className="ndot">{badgeText(badges[id])}</span>}
        </button>
      ))}
      {graph && (
        <button className="icon" disabled={scratch} onClick={() => view.run('module-graph')} title={withHint('Module graph', 'module-graph')}>
          <PIcon name="network" />
        </button>
      )}
    </div>
  )
  if (!shown) return bar

  // Esc in a field (the Explorer filter, a commit message) is that field's
  const onSheetKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    e.stopPropagation()
    dispatch({ type: 'set', patch: { panel: null } })
  }
  return (
    <>
      {bar}
      {/* Focusable, so a click on its text or a diff still leaves Esc with the sheet */}
      <aside className="card rpanel" tabIndex={-1} style={{ width: ui.panelWidth }} onKeyDown={onSheetKey}>
        <PanelResize view={view} />
        {shown === 'explorer' && <Explorer key={root} view={view} place={place} status={status} tick={tick} />}
        {shown === 'changes' && <Changes key={root} view={view} place={place} status={status} tick={tick} prs={prList} onPanel={openPanel} />}
        {shown === 'prs' && <Prs view={view} data={data} />}
        {shown === 'history' && <History view={view} place={place} />}
        {shown === 'tickets' && <Tickets view={view} data={tickets} refresh={tickets.refresh} repo={place.repoRoot} />}
        {shown === 'problems' && <Problems view={view} place={place} />}
        {shown === 'servers' && <Servers view={view} place={place} />}
      </aside>
    </>
  )
}

/** The sheet's left edge, like the sidebar's handle */
function PanelResize({ view }: { view: ShellView }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    const panel = handle.parentElement?.getBoundingClientRect()
    if (!panel) return
    const x = e.clientX
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('drag')
    const move = (ev: globalThis.PointerEvent) =>
      view.dispatch({ type: 'set', patch: { panelWidth: Math.round(Math.min(PANEL.max, Math.max(PANEL.min, panel.width + x - ev.clientX))) } })
    const up = () => {
      handle.classList.remove('drag')
      handle.removeEventListener('pointermove', move)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
  }
  return <div className="vsz" onPointerDown={onPointerDown} onDoubleClick={() => view.dispatch({ type: 'set', patch: { panelWidth: PANEL.initial } })} />
}

/** Exact up to 9999, then 10k, 1.2m */
const badgeText = (n: number) => (n < 10_000 ? n : compact(n).toLowerCase())
