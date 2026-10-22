import { useEffect, useState } from 'react'
import type { PullRequest } from '../ipc/api'
import { Icon } from '../lib/icons'
import type { ShellView } from '../shell/Shell'
import { Glyph } from './icons'
import { goTo, Modal, reposOf } from './index'
import { baseName, cleanable, removeWarnings, rowState, type WorktreeRow } from './logic'

const prOf = (prs: PullRequest[], repoPath: string, path: string, branch: string | null) => {
  const detached = /^(?:pr|mr)-(\d+)$/.exec(baseName(path))
  return prs.find((p) => p.repoPath === repoPath && p.state === 'open' && (branch ? p.sourceBranch === branch : String(p.number) === detached?.[1])) ?? null
}

/** Every worktree of the open repos: click one to go there, pick some to remove. `cleanup` preselects merged and gone ones */
export function Worktrees({ view, cleanup, onClose }: { view: ShellView; cleanup: boolean; onClose: () => void }) {
  const { api } = view
  const repos = reposOf(view)
  const repoKey = repos.map((r) => r.path).join('\n')
  const [rows, setRows] = useState<WorktreeRow[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [reload, setReload] = useState(0)

  const sessions = (path: string) => view.ordered.filter((t) => view.placeOfTab(t).path === path).length

  useEffect(() => {
    let cancelled = false
    const paths = repoKey ? repoKey.split('\n') : []
    void Promise.all([
      Promise.all(paths.map((p) => api.listWorktrees(p).catch(() => []))),
      api.listPullRequests(paths).then((l) => l.pullRequests, () => []),
    ])
      .then(([lists, prs]) =>
        Promise.all(
          lists.flatMap((list, i) =>
            list.map(async (worktree): Promise<WorktreeRow> => ({
              repoPath: paths[i],
              worktree,
              status: worktree.missing ? null : await api.gitStatus(worktree.path).catch(() => null),
              pr: prOf(prs, paths[i], worktree.path, worktree.branch),
              sessions: 0,
            }))
          )
        )
      )
      .then((found) => {
        if (cancelled) return
        setRows(found)
        if (cleanup && reload === 0) setSelected(new Set(found.filter(cleanable).map((r) => r.worktree.path)))
      })
    return () => {
      cancelled = true
    }
  }, [api, repoKey, cleanup, reload])

  const counted = rows?.map((r) => ({ ...r, sessions: sessions(r.worktree.path) })) ?? []
  const picked = counted.filter((r) => selected.has(r.worktree.path))
  const risky = picked.some((r) => removeWarnings(r).some(([level]) => level === 'err'))

  const toggle = (path: string) =>
    setSelected((all) => {
      const next = new Set(all)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const remove = async () => {
    setBusy(true)
    const failed: string[] = []
    const pruned = new Set<string>()
    for (const row of picked) {
      const { worktree, status } = row
      view.ordered.filter((t) => view.placeOfTab(t).path === worktree.path).forEach(view.closeTab)
      try {
        if (worktree.missing) {
          if (!pruned.has(row.repoPath)) await api.pruneWorktrees(row.repoPath)
          pruned.add(row.repoPath)
        } else await api.removeWorktree(worktree.path, !!status?.changes.length, !!(status?.merged || status?.gone))
      } catch (e) {
        failed.push(`${worktree.branch ?? baseName(worktree.path)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy(false)
    setErrors(failed)
    setSelected(new Set())
    if (!failed.length) return onClose()
    setReload((n) => n + 1)
  }

  let repo = ''
  return (
    <Modal className="wts" busy={busy} onClose={onClose}>
      <h3>
        <Icon name="branch" />
        Worktrees
      </h3>
      <p className="dim" style={{ margin: '-6px 0 10px', fontSize: 12 }}>
        Click one to open it. Pick the ones to remove.
      </p>
      <div className="clist">
        {!rows && <div className="empty">Loading...</div>}
        {rows && !rows.length && <div className="empty">No git repos open yet</div>}
        {counted.map((row) => {
          const { worktree, status } = row
          const head = row.repoPath !== repo
          repo = row.repoPath
          const on = selected.has(worktree.path)
          const state = rowState(row)
          const warnings = on ? removeWarnings(row) : []
          return (
            <div key={worktree.path}>
              {head && (
                <div className="mlabel">
                  <Icon name="book" />
                  {repos.find((r) => r.path === row.repoPath)?.name}
                  <span className="trunc">{row.repoPath.startsWith(`${view.home}/`) ? `~${row.repoPath.slice(view.home.length)}` : row.repoPath}</span>
                </div>
              )}
              <div className={`clrow ${on ? 'on' : ''} ${worktree.missing ? 'missing' : ''}`}>
                {worktree.main ? (
                  <span className="cbx none" />
                ) : (
                  <button className="cbx" title="Pick to remove" aria-pressed={on} onClick={() => toggle(worktree.path)}>
                    {on && <Glyph name="check" />}
                  </button>
                )}
                <div className="cb">
                  <button
                    className="t"
                    disabled={worktree.missing}
                    title={worktree.missing ? 'The folder was deleted outside Treeix: pick it to prune' : `Open ${worktree.path}`}
                    onClick={() => {
                      goTo(view, worktree.path)
                      onClose()
                    }}
                  >
                    <span className="wic" style={{ '--c': worktree.main ? 'var(--muted-foreground)' : 'var(--sky)' }}>
                      {worktree.branch ? <Icon name={worktree.main ? 'folder' : 'branch'} /> : <Glyph name="pr" />}
                    </span>
                    <span className="trunc nm">{worktree.branch ?? baseName(worktree.path)}</span>
                    {state && (
                      <span className={`tag ${state.tone === 'plain' ? '' : state.tone}`}>
                        {row.pr?.pipeline && <span className={`cidot ${row.pr.pipeline.status}`} />}
                        {state.label}
                      </span>
                    )}
                    <span className="grow" />
                    {!!status?.ahead && <span className="num">⇡{status.ahead}</span>}
                    {!!status?.behind && <span className="num">⇣{status.behind}</span>}
                    <span className="cnt">{row.sessions ? `${row.sessions} session${row.sessions > 1 ? 's' : ''}` : ''}</span>
                  </button>
                  {warnings.length > 0 && (
                    <ul className="warnl">
                      {warnings.map(([level, text]) => (
                        <li key={text} className={level}>
                          {text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {errors.length > 0 && (
        <ul className="warnl">
          {errors.map((e) => (
            <li key={e} className="err">
              {e}
            </li>
          ))}
        </ul>
      )}
      <div className="mft">
        <span className="dim">{picked.length} selected</span>
        <button className="btn" disabled={busy} onClick={() => setSelected(new Set(counted.filter(cleanable).map((r) => r.worktree.path)))}>
          Select merged and gone
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={!picked.length || busy} onClick={() => void remove()}>
          {busy ? 'Removing...' : `Remove ${picked.length || ''}${risky ? ' anyway' : ''}`}
        </button>
      </div>
    </Modal>
  )
}
