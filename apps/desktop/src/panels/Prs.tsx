import { useState } from 'react'
import type { MergeMethod, PullRequest, ProviderStatus, Worktree } from '../ipc/api'
import { Icon } from '../lib/icons'
import type { ShellView } from '../shell/Shell'
import { askAgent, Head, Menu, PIcon, runIn, type MenuItem } from './common'
import { ago, ciText, isMine } from './logic'

/** What the host loaded; the PR list refreshes on focus and every minute while this panel shows */
export interface PrData {
  list: PullRequest[]
  errors: { repoPath: string; message: string }[]
  /** The last refresh failed; `list` is the previous one */
  offline: boolean
  providers: ProviderStatus[]
  worktrees: Record<string, Worktree[]>
  refresh: () => void
}

type Filter = 'all' | 'mine' | 'review' | 'routines'

/** Branches routine runs push (`run_branch` in crates/core routines.rs) */
const fromRoutine = (pr: PullRequest) => pr.sourceBranch.startsWith('routine/')

const REVIEW: Record<NonNullable<PullRequest['review']>['state'], [string, string]> = {
  yours: ['', 'Yours'],
  requested: ['amber', 'Review requested'],
  approved: ['green', 'Approved'],
  changes: ['red', 'Changes requested'],
  commented: ['sky', 'Commented'],
  unreviewed: ['', 'No review'],
}
const PROVIDER = { github: ['GitHub', 'gh'], gitlab: ['GitLab', 'glab'] } as const

const lastPart = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The worktree with the PR's branch, or the detached `pr-N` / `mr-N` one a check out made */
export const prWorktree = (pr: PullRequest, worktrees: Record<string, Worktree[]>) =>
  worktrees[pr.repoPath]?.find((w) => w.branch === pr.sourceBranch || lastPart(w.path) === `${pr.provider === 'gitlab' ? 'mr' : 'pr'}-${pr.number}`)

function tagOf(pr: PullRequest): [string, string] {
  if (pr.state === 'merged') return ['violet', 'Merged']
  if (pr.state === 'closed') return ['', 'Closed']
  if (pr.draft) return ['', 'Draft']
  return pr.review ? REVIEW[pr.review.state] : ['', 'No review']
}

const EMPTY: Record<Filter, string> = { all: 'No pull requests', mine: 'None of yours open', review: 'No reviews waiting', routines: 'No routine has opened one yet' }

const STATES = {
  any: ['Any state', () => true],
  open: ['Open', (pr) => pr.state === 'open' && !pr.draft],
  draft: ['Draft', (pr) => pr.state === 'open' && pr.draft],
  approved: ['Approved', (pr) => pr.state === 'open' && pr.review?.state === 'approved'],
  changes: ['Changes requested', (pr) => pr.state === 'open' && pr.review?.state === 'changes'],
  failing: ['CI failing', (pr) => pr.state === 'open' && pr.pipeline?.status === 'failed'],
  conflicts: ['Conflicts', (pr) => pr.state === 'open' && pr.conflicts],
  merged: ['Merged', (pr) => pr.state === 'merged'],
  closed: ['Closed', (pr) => pr.state === 'closed'],
} as const satisfies Record<string, readonly [string, (pr: PullRequest) => boolean]>
type StateFilter = keyof typeof STATES

/** Narrowing on top of the tabs; empty author or repo means any */
interface Facets {
  state: StateFilter
  author: string
  repo: string
}
const ANY: Facets = { state: 'any', author: '', repo: '' }

/** Keeps the picked value listed after a refresh drops its last PR */
const options = (values: string[], picked: string) => [...new Set([...values, picked].filter(Boolean))].sort((a, b) => a.localeCompare(b))

/** The filters outlive switching panels */
let lastFilter: Filter = 'all'
let lastFacets = ANY

export function Prs({ view, data }: { view: ShellView; data: PrData }) {
  const { api } = view
  const [filter, keepFilter] = useState(lastFilter)
  const setFilter = (f: Filter) => keepFilter((lastFilter = f))
  const [facets, keepFacets] = useState(lastFacets)
  const setFacet = (patch: Partial<Facets>) => keepFacets((lastFacets = { ...facets, ...patch }))
  const narrowed = facets.state !== 'any' || facets.author !== '' || facets.repo !== ''
  /** Per PR: the running check out step, or the last error */
  const [busy, setBusy] = useState<Record<string, { text: string; error?: boolean }>>({})
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)

  const userOf = (pr: PullRequest) => data.providers.find((p) => p.provider === pr.provider)?.user ?? null
  const shown: Record<Filter, (pr: PullRequest) => boolean> = {
    all: () => true,
    mine: (pr) => isMine(pr, userOf(pr)),
    review: (pr) => pr.review?.state === 'requested' && pr.state === 'open',
    routines: fromRoutine,
  }
  const authors = options(data.list.map((pr) => pr.author), facets.author)
  const repos = options(data.list.map((pr) => pr.repoPath), facets.repo)
  const list = data.list.filter(
    (pr) => shown[filter](pr) && STATES[facets.state][1](pr) && (!facets.author || pr.author === facets.author) && (!facets.repo || pr.repoPath === facets.repo),
  )
  const idOf = (pr: PullRequest) => `${pr.repoPath}#${pr.number}`
  const note = (pr: PullRequest, text: string | null, error = false) =>
    setBusy((all) => {
      const next = { ...all }
      if (text === null) delete next[idOf(pr)]
      else next[idOf(pr)] = { text, error }
      return next
    })
  const run = (pr: PullRequest, call: Promise<unknown>) =>
    call.then(
      () => {
        note(pr, null)
        data.refresh()
      },
      (e: unknown) => note(pr, String(e), true),
    )

  const goTo = (path: string) => {
    const tab = view.ordered.find((t) => view.placeOfTab(t).path === path)
    if (tab) view.dispatch({ type: 'activate', tabId: tab.id })
    else view.newSession('shell', path)
  }

  /** The PR's worktree, checked out first when there is none */
  const ensure = async (pr: PullRequest): Promise<string | null> => {
    const existing = prWorktree(pr, data.worktrees)
    if (existing) return existing.path
    note(pr, 'Checking out...')
    try {
      const path = await api.addWorktree({ repoPath: pr.repoPath, pr: pr.number, branch: null, base: null, copyEnv: false, setup: null, skipFetch: false }, (step) =>
        note(pr, step.state === 'failed' ? (step.error ?? `${step.command} failed`) : `${step.command}...`, step.state === 'failed'),
      )
      note(pr, null)
      data.refresh()
      return path
    } catch (e) {
      note(pr, String(e), true)
      return null
    }
  }

  // The Open worktree dialog shows the steps, errors and Retry
  const checkOut = (pr: PullRequest) => view.openDialog({ kind: 'newWorktree', repo: pr.repoPath, pr: pr.number })
  const review = async (pr: PullRequest) => {
    const path = await ensure(pr)
    if (path !== null) await askAgent(view, 'claude', path, `Review PR #${pr.number}: ${pr.title}. Compare it with ${pr.targetBranch}.`, `Review #${pr.number}`)
  }
  const fixCi = (pr: PullRequest, path: string) => void askAgent(view, 'codex', path, `${ciText(pr.pipeline)} on #${pr.number}. Find the cause and fix it.`, `Fix CI #${pr.number}`)
  const merge = (pr: PullRequest, x: number, y: number) =>
    setMenu({
      at: { x, y },
      items: (['squash', 'merge', 'rebase'] as MergeMethod[]).map((method) => ({
        label: { squash: 'Squash and merge', merge: 'Merge commit', rebase: 'Rebase and merge' }[method],
        run: () => {
          note(pr, 'Merging...')
          void run(pr, api.mergePullRequest({ provider: pr.provider, repoPath: pr.repoPath, number: pr.number }, method, true))
        },
      })),
    })

  const actions = (pr: PullRequest) => {
    const wt = prWorktree(pr, data.worktrees)
    const out = []
    if (wt?.missing)
      out.push(
        <button key="prune" className="btn sm" onClick={() => void run(pr, api.pruneWorktrees(pr.repoPath))}>
          Prune missing worktree
        </button>,
      )
    else if (wt) {
      out.push(
        <button key="go" className="btn sm" onClick={() => goTo(wt.path)}>
          {wt.main ? <Icon name="folder" /> : <PIcon name="tree" />}
          Open {wt.main ? 'repo folder' : 'worktree'}
        </button>,
      )
      if (pr.state === 'merged' && !wt.main)
        out.push(
          <button key="clean" className="btn sm" onClick={() => view.openDialog({ kind: 'worktrees', cleanup: true })}>
            Clean up
          </button>,
        )
    } else if (pr.state === 'open')
      out.push(
        <button key="co" className="btn sm pri" onClick={() => checkOut(pr)}>
          <PIcon name="tree" />
          Check out in worktree
        </button>,
      )
    else
      out.push(
        <span key="none" className="dim" style={{ fontSize: 11 }}>
          {pr.state}, nothing to check out
        </span>,
      )
    if (pr.state === 'open' && pr.review?.state === 'requested')
      out.push(
        <button key="review" className="btn sm" onClick={() => void review(pr)}>
          <Icon name="claude" />
          Review with Claude
        </button>,
      )
    if (pr.state === 'open' && wt && !wt.missing && isMine(pr, userOf(pr)) && pr.pipeline?.status === 'failed')
      out.push(
        <button key="ci" className="btn sm" onClick={() => fixCi(pr, wt.path)}>
          <Icon name="codex" />
          Fix CI with Codex
        </button>,
      )
    if (pr.state === 'open' && !pr.draft)
      out.push(
        <button key="merge" className="btn sm" onClick={(e) => merge(pr, e.clientX, e.clientY)}>
          Merge
          <Icon name="down" />
        </button>,
      )
    return out
  }

  const signedOut = data.providers.filter((p) => p.installed && !p.signedIn)
  return (
    <>
      <Head title="Pull requests">
        <div className="seg">
          {(
            [
              ['all', 'All'],
              ['mine', 'Mine'],
              ['review', 'Review'],
              ['routines', 'Routines'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="icon sm" onClick={data.refresh} title="Refresh">
          <PIcon name="reload" />
        </button>
      </Head>
      <div className="pfil">
        <select value={facets.state} onChange={(e) => setFacet({ state: e.target.value as StateFilter })} aria-label="State">
          {Object.entries(STATES).map(([k, [label]]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select value={facets.author} onChange={(e) => setFacet({ author: e.target.value })} aria-label="Author">
          <option value="">Anyone</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        {repos.length > 1 && (
          <select value={facets.repo} onChange={(e) => setFacet({ repo: e.target.value })} aria-label="Repository">
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {lastPart(r)}
              </option>
            ))}
          </select>
        )}
        {narrowed && (
          <button className="icon sm" onClick={() => setFacet(ANY)} title="Clear filters">
            <Icon name="x" />
          </button>
        )}
      </div>
      {data.offline && (
        <div className="banner amber">
          <PIcon name="wifiOff" />
          <span className="grow">Offline. Showing the last list.</span>
        </div>
      )}
      {signedOut.map((p) => (
        <div key={p.provider} className="banner red">
          <PIcon name="key" />
          <span className="grow">
            <b>{PROVIDER[p.provider][0]}: signed out.</b> Its {p.provider === 'gitlab' ? 'MRs' : 'PRs'} are hidden.
          </span>
          <button className="btn sm pri" onClick={() => void runIn(view, view.home, `${PROVIDER[p.provider][1]} auth login`)}>
            Sign in
          </button>
        </div>
      ))}
      {data.errors.map((e) => (
        <div key={e.repoPath} className="banner red">
          <Icon name="alert" />
          <span className="grow">
            <b>{lastPart(e.repoPath)}:</b> {e.message}
          </span>
        </div>
      ))}
      <div className="pscroll">
        {list.length ? (
          list.map((pr) => {
            const wt = prWorktree(pr, data.worktrees)
            const [tagColor, tagText] = tagOf(pr)
            const state = busy[idOf(pr)]
            return (
              <div key={idOf(pr)} className="pr">
                <span className={pr.state === 'merged' ? 'violet' : pr.draft || pr.state === 'closed' ? 'dim' : pr.pipeline?.status === 'failed' ? 'err' : 'ok'}>
                  <PIcon name="pr" />
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t">
                    <a
                      href={pr.url}
                      onClick={(e) => {
                        e.preventDefault()
                        void api.openUrl(pr.url)
                      }}
                      title="Open in browser"
                    >
                      {pr.title}
                    </a>
                  </div>
                  <div className="m dots">
                    <span className={`prov ${pr.provider === 'gitlab' ? 'gl' : 'gh'}`}>{PROVIDER[pr.provider][0]}</span>
                    <span>
                      {lastPart(pr.repoPath)} {pr.provider === 'gitlab' ? '!' : '#'}
                      {pr.number}
                    </span>
                    <span className="mid">{pr.author}</span>
                    <span className="mid">{ago(Date.parse(pr.updatedAt))}</span>
                    {wt && !wt.main && <span className="mid dim">{wt.branch ?? lastPart(wt.path)}</span>}
                  </div>
                  <div className="m">
                    {pr.state === 'open' && pr.pipeline && (
                      <span className="ci">
                        <span className={`cidot ${pr.pipeline.status}`} />
                        {ciText(pr.pipeline)}
                      </span>
                    )}
                    <span className={`tag ${tagColor}`}>{tagText}</span>
                    {pr.conflicts && pr.state === 'open' && <span className="tag red">conflicts</span>}
                    {pr.additions !== null && <span className="ok">+{pr.additions}</span>}
                    {pr.deletions !== null && <span className="err">-{pr.deletions}</span>}
                  </div>
                  {state && <div className={`m ${state.error ? 'err' : 'dim'}`}>{state.text}</div>}
                  <div className="a">{actions(pr)}</div>
                </div>
              </div>
            )
          })
        ) : (
          <div className="empty">{narrowed ? 'No pull requests match' : EMPTY[filter]}</div>
        )}
      </div>
      <div className="cfoot dim" style={{ fontSize: 11 }}>
        <PIcon name="globe" />
        Sources:
        {(['github', 'gitlab'] as const).map((provider) => {
          const p = data.providers.find((x) => x.provider === provider)
          return (
            <span key={provider}>
              {PROVIDER[provider][0]} via {PROVIDER[provider][1]}{' '}
              {!p?.installed ? <span className="dim">not installed</span> : p.signedIn ? <span className="ok">✓</span> : <span className="err">signed out</span>}
            </span>
          )
        })}
      </div>
      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  )
}
