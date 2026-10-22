import { useEffect, useState, type KeyboardEvent } from 'react'
import type { Branch, GitStatus, NewWorktree as Request, PullRequest, StepId, Worktree, WorktreeStep } from '../ipc/api'
import { Icon } from '../lib/icons'
import { IS_MAC } from '../shell/shortcuts'
import type { ShellView } from '../shell/Shell'
import { Glyph } from './icons'
import { goTo, Modal, reposOf, type DialogRequest } from './index'
import { branchCheck, branchRows, localName, prDir, setupCommand, worktreeDir } from './logic'

type Agent = 'claude' | 'codex' | null

interface RepoData {
  branches: Branch[]
  worktrees: Worktree[]
  status: GitStatus | null
  prs: PullRequest[]
  /** Names in the repo folder: `.env`, lockfiles */
  names: string[]
}

type StepKey = StepId | 'open'
interface Step {
  key: StepKey
  label: string
  command: string
  state: 'todo' | 'cur' | 'done' | 'fail' | 'skipped'
  error: string | null
}

const STATE: Record<WorktreeStep['state'], Step['state']> = { running: 'cur', done: 'done', failed: 'fail', skipped: 'skipped' }
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export function NewWorktree({ view, request, onClose }: { view: ShellView; request: Extract<DialogRequest, { kind: 'newWorktree' }>; onClose: () => void }) {
  const { api } = view
  const repos = reposOf(view)
  const active = view.activeTab && view.placeOfTab(view.activeTab)
  const [repo, setRepo] = useState(request.repo ?? repos[0]?.path ?? '')
  const [data, setData] = useState<RepoData | null>(null)
  const [reload, setReload] = useState(0)
  const [mode, setMode] = useState<'branch' | 'pr'>(request.pr ? 'pr' : 'branch')
  const [prNumber, setPrNumber] = useState<number | null>(request.pr ?? null)
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(false)
  const [hi, setHi] = useState(0)
  const [valid, setValid] = useState<boolean | null>(null)
  const [base, setBase] = useState('')
  const [agent, setAgent] = useState<Agent>('claude')
  const [copyEnv, setCopyEnv] = useState(true)
  const [runSetup, setRunSetup] = useState(true)
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState<Request | null>(null)

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    void Promise.all([
      api.listBranches(repo),
      api.listWorktrees(repo),
      api.gitStatus(repo),
      api.listPullRequests([repo]).then((l) => l.pullRequests.filter((p) => p.state === 'open'), () => []),
      api.listDirectory(repo, '').catch(() => []),
    ]).then(([branches, worktrees, status, prs, names]) => {
      if (cancelled) return
      setData({ branches, worktrees, status, prs, names })
      setBase((b) => b || defaultBase(status, branches))
    })
    return () => {
      cancelled = true
    }
  }, [api, repo, reload])

  const branch = localName(name.trim())
  useEffect(() => {
    if (!branch) return
    let cancelled = false
    setValid(null)
    void api.checkBranchName(branch).then((ok) => !cancelled && setValid(ok))
    return () => {
      cancelled = true
    }
  }, [api, branch])

  const repoName = repos.find((r) => r.path === repo)?.name ?? repo
  const notGit = active && !active.repoRoot ? active.name : null
  if (!repos.length || !repo)
    return (
      <Modal className="nw" onClose={onClose}>
        <h3>
          <Icon name="branch" />
          Open worktree
        </h3>
        <div className="empty">Worktrees need a git repo. Open one, or git init a folder.</div>
        <div className="mft">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    )

  const setup = data && setupCommand(data.names)
  const hasEnv = !!data?.names.includes('.env')
  const hasRemote = !!data && (!!data.status?.upstream || data.branches.some((b) => b.remote))
  const pr = mode === 'pr' ? (data?.prs.find((p) => p.number === prNumber) ?? null) : null
  const ctx = { repoPath: repo, branches: data?.branches ?? [], worktrees: data?.worktrees ?? [], open: new Set(view.ordered.map((t) => view.placeOfTab(t).path)), prs: data?.prs ?? [] }
  const check = data ? branchCheck({ ...ctx, name: branch, valid: branch ? valid : true, hasCommits: data.status?.head !== null, repoName }) : null
  const known = ctx.branches.some((b) => localName(b.name) === branch)
  const rows = picking && data ? branchRows(ctx, name) : []
  const current = Math.min(hi, rows.length - 1)
  const go = mode === 'branch' && check?.level === 'go' ? check.worktree : null
  const ready = !!data && (mode === 'pr' ? !!pr : !check || check.level === 'info' || check.level === 'go')
  const dir = pr ? prDir(pr.number, pr.provider === 'gitlab') : worktreeDir(branch || '...')

  const run = (req: Request) => {
    const plan: Step[] = []
    const add = (key: StepKey, label: string, command: string) => plan.push({ key, label, command, state: 'todo', error: null })
    if (req.pr !== null || hasRemote) add('fetch', req.pr !== null ? `Fetch #${req.pr}` : 'Fetch origin', 'git fetch origin')
    add('add', `Add ${dir}`, req.pr !== null ? `git worktree add --detach ${dir} FETCH_HEAD` : `git worktree add ${dir} ${req.branch}`)
    if (req.copyEnv) add('env', 'Copy .env', 'cp .env')
    if (req.setup) add('setup', 'Run setup', req.setup)
    add('open', agent ? `Start ${cap(agent)}` : 'Open a shell', agent ?? 'zsh')
    setSteps(plan)
    setFailure(null)
    setSent(req)
    api
      .addWorktree(req, (s) => setSteps((all) => all?.map((x) => (x.key === s.step ? { ...x, state: STATE[s.state], command: s.command || x.command, error: s.error } : x)) ?? null))
      .then(
        (path) => {
          view.newSession(agent ?? 'shell', path)
          onClose()
        },
        (e: unknown) => setFailure(e instanceof Error ? e.message : String(e))
      )
  }

  const submit = () => {
    if (!ready || steps) return
    if (go) {
      goTo(view, go.path, agent ?? 'shell')
      return onClose()
    }
    run({
      repoPath: repo,
      branch: pr ? null : branch,
      base: pr || known ? null : base || null,
      pr: pr?.number ?? null,
      copyEnv: hasEnv && copyEnv,
      setup: setup && runSetup ? setup : null,
      skipFetch: !hasRemote,
    })
  }

  const pick = (value: string) => {
    setName(value)
    setPicking(false)
  }

  const onBranchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && picking && rows[current]) pick(rows[current].name)
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) setHi((current + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    else if (e.key === 'Escape' && picking) setPicking(false)
    else return
    e.preventDefault()
  }

  if (steps && sent) {
    const fetchFailed = steps.some((s) => s.key === 'fetch' && s.state === 'fail')
    return (
      <Modal className="nw" busy={!failure} onClose={onClose}>
        <h3>
          {sent.pr !== null ? <Glyph name="pr" /> : <Icon name="branch" />}
          {sent.pr !== null ? `Checking out #${sent.pr}` : `Opening ${sent.branch}`}
          <span className="grow" />
          <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>
            {repoName}
          </span>
        </h3>
        <div className="steps">
          {steps.map((s) => (
            <div key={s.key} className={`step ${s.state === 'skipped' ? 'done' : s.state}`}>
              <span className="sic">{s.state === 'done' || s.state === 'skipped' ? <Glyph name="check" /> : s.state === 'fail' ? <Icon name="x" /> : <i />}</span>
              <div className="grow">
                <div>
                  {s.label}
                  {s.state === 'skipped' && <span className="dim"> skipped</span>}
                </div>
                <div className="mono dim trunc">{s.command}</div>
                {s.error && <div className="mono err">{s.error}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="mft">
          {failure ? (
            <>
              <span className="dim" style={{ fontSize: 11 }}>
                {!fetchFailed ? failure : sent.pr !== null ? 'Checking out a PR needs the network' : `Without it the new branch starts from your last fetch of ${sent.base ?? 'the base'}`}
              </span>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              {fetchFailed && sent.pr === null && (
                <button className="btn" onClick={() => run({ ...sent, skipFetch: true })}>
                  Continue without fetching
                </button>
              )}
              <button className="btn pri" autoFocus onClick={() => run(sent)}>
                <Glyph name="reload" />
                Retry
              </button>
            </>
          ) : (
            <span className="dim" style={{ fontSize: 11 }}>
              Git is working. Closing waits until it finishes.
            </span>
          )}
        </div>
      </Modal>
    )
  }

  const bases = data ? baseOptions(data, hasRemote) : []
  const label = mode === 'pr' ? 'Check out' : go ? (go.path === repo ? 'Open repo folder' : 'Open worktree') : known ? 'Check out' : 'Create worktree'

  return (
    <Modal className="nw" onClose={onClose}>
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
      >
        <h3>
          <Icon name="branch" />
          Open worktree
          <span className="grow" />
          <span className="seg" style={{ fontWeight: 400 }}>
            <button className={mode === 'branch' ? 'on' : ''} onClick={() => setMode('branch')}>
              <Icon name="branch" />
              Branch
            </button>
            <button className={mode === 'pr' ? 'on' : ''} onClick={() => setMode('pr')}>
              <Glyph name="pr" />
              {data?.prs.some((p) => p.provider === 'gitlab') ? 'Merge request' : 'Pull request'}
            </button>
          </span>
        </h3>
        {notGit && (
          <div className="banner">
            <Icon name="folder" />
            <span className="grow">{notGit} is not a git repo, so pick which repo gets the worktree.</span>
          </div>
        )}
        <div className="frow2">
          <div className="fld">
            <label htmlFor="nw-repo">Repository</label>
            <select
              id="nw-repo"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value)
                setData(null)
                setBase('')
                setPrNumber(null)
              }}
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          {mode === 'branch' && (
            <div className="fld">
              <label htmlFor="nw-base">From</label>
              <select id="nw-base" value={base} disabled={known} title={known ? 'The branch exists, so it keeps its own history' : undefined} onChange={(e) => setBase(e.target.value)}>
                {bases.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {mode === 'branch' ? (
          <>
            <div className="fld bfield">
              <label htmlFor="nw-branch">Branch</label>
              <input
                id="nw-branch"
                autoFocus
                value={name}
                placeholder="Search branches or name a new one"
                spellCheck={false}
                autoComplete="off"
                onFocus={() => setPicking(true)}
                onBlur={() => setPicking(false)}
                onChange={(e) => {
                  setName(e.target.value)
                  setPicking(true)
                  setHi(0)
                }}
                onKeyDown={onBranchKey}
              />
              {rows.length > 0 && (
                <div className="sugg" onMouseDown={(e) => e.preventDefault()}>
                  {rows.map((r, i) => (
                    <button key={`${r.create}${r.name}`} className={`mi ${i === current ? 'on' : ''}`} onMouseMove={() => setHi(i)} onClick={() => pick(r.name)}>
                      {r.create ? <Icon name="plus" /> : r.remote ? <Glyph name="globe" /> : <Icon name="branch" />}
                      <span className="trunc">
                        {r.create ? (
                          <>
                            Create <b>{r.name}</b> from {base}
                          </>
                        ) : (
                          r.name
                        )}
                      </span>
                      {r.pr !== null && <span className="tag">#{r.pr}</span>}
                      {!r.create && <span className={`d ${r.missing ? 'err' : ''}`}>{r.detail}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {check && (
              <div className={`nwchk ${check.level}`}>
                {check.level === 'err' ? <Icon name="alert" /> : <Icon name="branch" />}
                <span className="grow">{check.text}</span>
                {check.level === 'err' && check.worktree?.missing && (
                  <button className="btn sm" onClick={() => void api.pruneWorktrees(repo).then(() => setReload((n) => n + 1))}>
                    Prune it
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <PrPicker prs={data?.prs ?? null} selected={pr} onPick={setPrNumber} dir={dir} />
        )}
        <div className="thenopen">
          <span>Then open</span>
          {(['claude', 'codex'] as const).map((a) => (
            <button key={a} className={`tog ${agent === a ? 'on' : ''}`} onClick={() => setAgent(agent === a ? null : a)}>
              <span className={a}>
                <Icon name={a} />
              </span>
              {cap(a)}
            </button>
          ))}
          <span className="dim" style={{ fontSize: 11 }}>
            {agent ? '' : 'none: a shell'}
          </span>
        </div>
        {(hasEnv || setup) && !go && (
          <div className="opts">
            {hasEnv && (
              <label className="chk">
                <input type="checkbox" checked={copyEnv} onChange={(e) => setCopyEnv(e.target.checked)} />
                Copy .env from the repo folder <span className="dim">(git-ignored)</span>
              </label>
            )}
            {setup && (
              <label className="chk">
                <input type="checkbox" checked={runSetup} onChange={(e) => setRunSetup(e.target.checked)} />
                Run setup: <span className="mono">{setup}</span>
              </label>
            )}
          </div>
        )}
        <div className="mft">
          <span className="dim mono trunc">{go ? go.path : `${repo}/${dir}`}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={!ready} onClick={submit}>
            {label} <kbd>{IS_MAC ? '⌘↵' : 'Ctrl+↵'}</kbd>
          </button>
        </div>
      </div>
    </Modal>
  )
}

function PrPicker({ prs, selected, onPick, dir }: { prs: PullRequest[] | null; selected: PullRequest | null; onPick: (n: number) => void; dir: string }) {
  if (!prs) return <div className="empty">Loading pull requests...</div>
  if (!prs.length) return <div className="empty">No open pull requests in this repo</div>
  return (
    <>
      <div className="prlist">
        {prs.map((p) => (
          <button key={p.number} className={`mi ${p.number === selected?.number ? 'on' : ''}`} onClick={() => onPick(p.number)}>
            <Glyph name="pr" />
            <span className="num">#{p.number}</span>
            <span className="trunc">{p.title}</span>
            <span className="d">{p.author}</span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="prcard">
          <div className="t">
            <b className="trunc">{selected.title}</b>
          </div>
          <div className="dim">
            {selected.author} · {selected.sourceBranch}
            {selected.additions !== null && (
              <>
                {' · '}
                <span className="ok">+{selected.additions}</span> <span className="err">-{selected.deletions}</span>
              </>
            )}
            {selected.pipeline && (
              <>
                {' · '}
                <span className={`cidot ${selected.pipeline.status}`} />
                CI {selected.pipeline.status === 'running' ? `${selected.pipeline.done}/${selected.pipeline.total}` : selected.pipeline.status}
              </>
            )}
          </div>
          <div className="nwchk" style={{ margin: 0 }}>
            <Icon name="branch" />
            <span className="grow">
              Opens in <span className="mono">{dir}</span> at detached HEAD <span className="mono">{selected.head}</span>: no local branch, nothing to clean up after the review
            </span>
          </div>
        </div>
      )}
    </>
  )
}

/** `origin/<default>` when there is a remote, else the default branch */
function defaultBase(status: GitStatus | null, branches: Branch[]) {
  const main = status?.base ?? branches.find((b) => !b.remote)?.name ?? 'main'
  return branches.some((b) => b.name === `origin/${main}`) || status?.upstream ? `origin/${main}` : main
}

function baseOptions({ status, branches }: RepoData, remote: boolean) {
  const main = status?.base ?? 'main'
  const local = branches.filter((b) => !b.remote).map((b) => b.name)
  return [...new Set([...(remote ? [`origin/${main}`] : []), main, ...local])]
}
