import { useEffect, useEffectEvent, useState, type PointerEvent } from 'react'
import type { GitStatus, PullRequest } from '../ipc/api'
import { fallbackPlace } from '../shell/model'
import { PANEL, type PanelId } from '../shell/state'
import type { ShellView } from '../shell/Shell'
import { Changes } from './Changes'
import { PIcon, type PanelIconName } from './common'
import { Explorer } from './Explorer'
import { History } from './History'
import { needsYou } from './logic'
import { Prs, type PrData } from './Prs'
import '../styles/panels.css'

const PR_REFRESH_MS = 60_000

const ITEMS: [PanelId, PanelIconName | 'folder' | 'branch', string][] = [
  ['explorer', 'folder', 'Explorer (⇧⌘E)'],
  ['changes', 'branch', 'Changes (⌃⇧G)'],
  ['prs', 'pr', 'Pull requests'],
  ['history', 'history', 'Session history'],
]

/** ⇧⌘E and ⌃⇧G; matched on `code` so the layout doesn't matter */
const panelKey = (e: KeyboardEvent): PanelId | null =>
  e.code === 'KeyE' && e.shiftKey && e.metaKey && !e.ctrlKey && !e.altKey ? 'explorer' : e.code === 'KeyG' && e.shiftKey && e.ctrlKey && !e.metaKey && !e.altKey ? 'changes' : null

/** Activity bar plus the open side panel; `hidden` while a page (settings) covers the center */
export function Panels({ view, hidden }: { view: ShellView; hidden: boolean }) {
  const { api, ui, dispatch, activeTab, home } = view
  const place = activeTab ? view.placeOfTab(activeTab) : fallbackPlace(home, home)
  const root = place.path
  const scratch = place.kind === 'scratch'
  const shown = hidden ? null : ui.panel

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
    let live = true
    const repos = repoKey ? repoKey.split('\n') : []
    void Promise.all([api.listPullRequests(repos), api.prProviders(), Promise.all(repos.map((r) => api.listWorktrees(r).catch(() => [])))]).then(
      ([list, providers, worktrees]) =>
        live && setPrs({ list: list.pullRequests, errors: list.errors, offline: false, providers, worktrees: Object.fromEntries(repos.map((r, i) => [r, worktrees[i]])) }),
      () => live && setPrs((last) => ({ ...last, offline: true })),
    )
    return () => void (live = false)
  }, [api, repoKey, prTick])
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
    if (hidden) view.run('settings')
    dispatch({ type: 'set', patch: { panel: ui.panel === id && !hidden ? null : id } })
  }
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const id = panelKey(e)
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    toggle(id)
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  const userOf = (pr: PullRequest) => prs.providers.find((p) => p.provider === pr.provider)?.user ?? null
  const badges: Partial<Record<PanelId, number>> = { changes: status?.changes.length ?? 0, prs: prs.list.filter((pr) => needsYou(pr, userOf(pr))).length }
  const data: PrData = { ...prs, refresh: refreshPrs }
  const openPanel = (id: PanelId) => dispatch({ type: 'set', patch: { panel: id } })

  const bar = (
    <div className="actbar" key="bar">
      {ITEMS.map(([id, icon, tip]) => (
        <button key={id} className={`icon ${shown === id ? 'on' : ''}`} onClick={() => toggle(id)} title={tip}>
          <PIcon name={icon} />
          {!!badges[id] && <span className="ndot">{badges[id]}</span>}
        </button>
      ))}
    </div>
  )
  if (!shown) return bar

  const panel = (
    <aside className="card rpanel" key="panel" style={{ width: ui.panelWidth }}>
      {shown === 'explorer' && <Explorer key={root} view={view} place={place} status={status} tick={tick} />}
      {shown === 'changes' && <Changes key={root} view={view} place={place} status={status} tick={tick} prs={prs.list} onPanel={openPanel} />}
      {shown === 'prs' && <Prs view={view} data={data} />}
      {shown === 'history' && <History view={view} place={place} />}
    </aside>
  )
  const vertical = ui.orientation === 'vertical'
  const resize = <PanelResize key="resize" view={view} fromRight={vertical} />
  return vertical ? [resize, panel, bar] : [bar, panel, resize]
}

/** Like the sidebar's handle; the panel sits on the far side of it */
function PanelResize({ view, fromRight }: { view: ShellView; fromRight: boolean }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    const panel = (fromRight ? handle.nextElementSibling : handle.previousElementSibling)?.getBoundingClientRect()
    if (!panel) return
    const edge = fromRight ? panel.right : panel.left
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('drag')
    const move = (ev: globalThis.PointerEvent) =>
      view.dispatch({ type: 'set', patch: { panelWidth: Math.round(Math.min(PANEL.max, Math.max(PANEL.min, fromRight ? edge - ev.clientX : ev.clientX - edge))) } })
    const up = () => {
      handle.classList.remove('drag')
      handle.removeEventListener('pointermove', move)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
  }
  return <div className="vsz" onPointerDown={onPointerDown} onDoubleClick={() => view.dispatch({ type: 'set', patch: { panelWidth: PANEL.initial } })} />
}
