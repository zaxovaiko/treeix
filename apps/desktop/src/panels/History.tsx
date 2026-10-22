import { useEffect, useState } from 'react'
import type { Branch, Place, SessionRecord, Worktree } from '../ipc/api'
import { Icon } from '../lib/icons'
import { DOT_LABEL, Ki, tabDot, tabKind, tabTitle } from '../shell/model'
import { placeLabel } from '../shell/state'
import type { ShellView } from '../shell/Shell'
import { RunMark } from '../features/routines'
import { Head, openSession, PIcon } from './common'
import { ago, dayLabel } from './logic'

type Kind = 'all' | SessionRecord['kind']

/** Where a closed session can come back: its own folder, the repo folder, or a recreated worktree */
interface Where {
  ok: boolean
  label: string
  repoRoot: string | null
  /** Why it can't come back where it was */
  why: 'worktree missing' | 'branch deleted' | 'worktree removed' | null
}

interface Repo {
  worktrees: Worktree[]
  branches: Branch[]
}

const lastPart = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The filter outlives switching panels */
let lastKind: Kind = 'all'

export function History({ view, place }: { view: ShellView; place: Place }) {
  const { api } = view
  const [records, setRecords] = useState<SessionRecord[]>([])
  const [places, setPlaces] = useState<Record<string, Place>>({})
  const [repos, setRepos] = useState<Record<string, Repo>>({})
  const [kind, keepKind] = useState(lastKind)
  const setKind = (k: Kind) => keepKind((lastKind = k))
  /** Bumped to drop an in-flight load that predates a forget */
  const [loads, setLoads] = useState(0)
  const [q, setQ] = useState('')
  const [here, setHere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Sessions closing land in the history: reload when the set of sessions changes
  const sessionIds = Object.keys(view.sessions).sort().join()

  useEffect(() => {
    let live = true
    void api.sessionHistory().then(async (list) => {
      const cwds = [...new Set(list.flatMap((r) => [r.cwd, ...(r.repoRoot ? [r.repoRoot] : [])]))]
      const resolved = cwds.length ? await api.places(cwds) : []
      const byPath = Object.fromEntries(resolved.map((p, i) => [cwds[i], p]))
      // Only repos with a session whose folder is gone need their worktrees and branches
      const roots = [...new Set(list.filter((r) => r.repoRoot && byPath[r.cwd]?.missing && !byPath[r.repoRoot]?.missing).map((r) => r.repoRoot ?? ''))]
      const loaded = await Promise.all(roots.map((root) => Promise.all([api.listWorktrees(root), api.listBranches(root)]).catch((): [Worktree[], Branch[]] => [[], []])))
      if (!live) return
      setRecords([...list].sort((a, b) => b.closedAt - a.closedAt))
      setPlaces(byPath)
      setRepos(Object.fromEntries(roots.map((root, i) => [root, { worktrees: loaded[i][0], branches: loaded[i][1] }])))
    })
    return () => void (live = false)
  }, [api, sessionIds, loads])

  const where = (r: SessionRecord): Where => {
    const p = places[r.cwd]
    if (p && !p.missing) return { ok: true, label: placeLabel(p), repoRoot: r.repoRoot, why: null }
    const repo = r.repoRoot && places[r.repoRoot] && !places[r.repoRoot].missing ? repos[r.repoRoot] : undefined
    const label = r.repoRoot ? `${lastPart(r.repoRoot)}/${r.branch ?? lastPart(r.cwd)}` : lastPart(r.cwd)
    if (!repo || !r.repoRoot) return { ok: false, label, repoRoot: null, why: null }
    if (repo.worktrees.some((w) => w.path === r.cwd && w.missing)) return { ok: false, label, repoRoot: r.repoRoot, why: 'worktree missing' }
    if (r.branch && !repo.branches.some((b) => b.name === r.branch)) return { ok: false, label, repoRoot: r.repoRoot, why: 'branch deleted' }
    return { ok: false, label, repoRoot: r.repoRoot, why: 'worktree removed' }
  }

  const resume = async (r: SessionRecord, fork: boolean, cwd: string) => {
    const command =
      r.agentSession && r.kind === 'claude'
        ? ['claude', '--resume', r.agentSession, ...(fork ? ['--fork-session'] : [])]
        : r.agentSession && r.kind === 'codex'
          ? ['codex', 'resume', r.agentSession]
          : r.kind === 'shell' && r.command.length
            ? r.command
            : undefined
    await openSession(view, { kind: r.kind, cwd, command, title: fork ? `Fork: ${r.title}` : r.title })
    if (fork) return
    await api.forgetSession(r.id)
    setRecords((all) => all.filter((x) => x.id !== r.id))
    setLoads((n) => n + 1)
  }
  const attempt = (call: Promise<unknown>) => void call.then(() => setError(null), (e: unknown) => setError(String(e)))
  const recreate = (r: SessionRecord, repoRoot: string) =>
    attempt(
      api
        .addWorktree({ repoPath: repoRoot, branch: r.branch, pr: null, base: null, copyEnv: false, setup: null, skipFetch: false }, () => {})
        .then((path) => resume(r, false, path)),
    )

  const query = q.trim().toLowerCase()
  const match = (k: SessionRecord['kind'] | 'routine', text: string, path: string) =>
    (kind === 'all' || k === kind) && (!query || text.toLowerCase().includes(query)) && (!here || path === place.path)
  const open = view.ordered.filter((t) => match(tabKind(t, view.sessions), tabTitle(t, view.sessions), view.placeOfTab(t).path))
  const closed = records.filter((r) => match(r.kind, `${r.title} ${r.firstPrompt ?? ''}`, r.cwd))
  const days = closed.map((r) => dayLabel(r.closedAt))

  return (
    <>
      <Head title="History">
        <div className="seg">
          {(['all', 'claude', 'codex', 'shell'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      </Head>
      <label className="filter">
        <Icon name="search" />
        <input placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      </label>
      <label className="chk">
        <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} />
        <span className="trunc">Only {placeLabel(place)}</span>
      </label>
      {error && (
        <div className="banner red">
          <Icon name="alert" />
          <span className="grow">{error}</span>
        </div>
      )}
      <div className="pscroll">
        {open.length > 0 && <div className="sec">Open now</div>}
        {open.map((tab) => {
          const dot = tabDot(tab, view.sessions)
          return (
            <div key={tab.id} className="hrow open" onClick={() => view.dispatch({ type: 'activate', tabId: tab.id })}>
              <Ki kind={tabKind(tab, view.sessions)} dot={dot} sm />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t trunc">{tabTitle(tab, view.sessions)}</div>
                <div className="m">
                  {placeLabel(view.placeOfTab(tab))} · {DOT_LABEL[dot]}
                </div>
              </div>
            </div>
          )
        })}
        {closed.map((r, i) => {
          const w = where(r)
          const agent = r.kind !== 'shell'
          const header = days[i] !== days[i - 1] ? days[i] : null
          return (
            <div key={r.id}>
              {header && <div className="sec">{header}</div>}
              <div className="hrow">
                <Ki kind={r.kind} sm />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t trunc">
                    {r.title}
                    <RunMark view={view} run={r.run} />
                  </div>
                  <div className="m dots">
                    <span>{w.label}</span>
                    {w.why && <span className={`tag ${w.why === 'worktree missing' ? 'red' : ''}`}>{w.why}</span>}
                    {r.messages !== null && <span className="mid">{r.messages} msgs</span>}
                    {r.cost !== null && <span className="mid">${r.cost.toFixed(2)}</span>}
                    <span className="mid">{ago(r.closedAt)}</span>
                  </div>
                  {r.firstPrompt && <div className="m trunc first">{r.firstPrompt}</div>}
                  <div className="a">
                    {w.ok ? (
                      <>
                        <button className="btn sm pri" onClick={() => attempt(resume(r, false, r.cwd))}>
                          <PIcon name="play" />
                          {agent && r.agentSession ? 'Resume' : 'Reopen'}
                        </button>
                        {r.kind === 'claude' && r.agentSession && (
                          <button className="btn sm" onClick={() => attempt(resume(r, true, r.cwd))}>
                            <PIcon name="fork" />
                            Fork
                          </button>
                        )}
                      </>
                    ) : w.repoRoot ? (
                      <>
                        <button className="btn sm pri" onClick={() => attempt(resume(r, false, w.repoRoot ?? r.cwd))}>
                          <Icon name="folder" />
                          {agent && r.agentSession ? 'Resume' : 'Reopen'} in repo folder
                        </button>
                        {w.why !== 'branch deleted' && r.branch && w.repoRoot && (
                          <button className="btn sm" onClick={() => w.repoRoot && recreate(r, w.repoRoot)}>
                            <PIcon name="tree" />
                            Recreate worktree
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="dim" style={{ fontSize: 11 }}>
                        the folder is not on this Mac
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        {!open.length && !closed.length && <div className="empty">{records.length || view.ordered.length ? 'No sessions match' : 'No sessions yet. Closed sessions land here and can be resumed.'}</div>}
      </div>
    </>
  )
}
