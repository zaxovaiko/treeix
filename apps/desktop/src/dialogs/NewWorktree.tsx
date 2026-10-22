import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { launch } from '../features/agents/launch'
import { raceTargets, type AgentName, type Target } from '../features/agents/race'
import { useSettings } from '../features/agents/settings'
import { FIcon } from '../features/agents/icons'
import { ticketBranch, ticketPrompt, ticketRows } from '../features/tickets/branch'
import { useTickets } from '../features/tickets/useTickets'
import type { Branch, GitStatus, NewWorktree as Request, PullRequest, Ticket, Worktree, WorktreeStep } from '../ipc/api'
import { Icon } from '../lib/icons'
import { IS_MAC } from '../shell/shortcuts'
import type { ShellView } from '../shell/Shell'
import { Glyph } from './icons'
import { goTo, Modal, reposOf, type DialogRequest } from './index'
import { branchCheck, branchRows, localName, prDir, setupCommand, worktreeDir, type BranchRow } from './logic'

interface RepoData {
  branches: Branch[]
  worktrees: Worktree[]
  status: GitStatus | null
  prs: PullRequest[]
  /** Names in the repo folder: `.env`, lockfiles */
  names: string[]
}

interface Step {
  /** `<target>:<step id>`, or `open` */
  key: string
  label: string
  command: string
  state: 'todo' | 'cur' | 'done' | 'fail' | 'skipped'
  error: string | null
}

/** A branch suggestion or one of your tickets */
type SuggRow = BranchRow | { ticket: Ticket }

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
  const [agents, setAgents] = useState<AgentName[]>(['claude'])
  const [prompt, setPrompt] = useState('')
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [shellSplit, setShellSplit] = useState(true)
  const [draftPr, setDraftPr] = useState(false)
  const [copyEnv, setCopyEnv] = useState(true)
  const [runSetup, setRunSetup] = useState(true)
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState<Request | null>(null)
  /** The race target that failed, where Retry starts; earlier targets' worktrees are in `paths` */
  const [failedAt, setFailedAt] = useState(0)
  const paths = useRef<string[]>([])
  const settings = useSettings(api)
  const { tickets, errors: ticketErrors } = useTickets(api, settings)
  const agent = agents[0] ?? null
  const racing = mode === 'branch' && agents.length > 1

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
  const branchList = picking && data ? branchRows(ctx, name) : []
  const ticketList = picking && data ? ticketRows(tickets, ctx.branches.map((b) => b.name), name) : []
  const rows: SuggRow[] = [...branchList.filter((r) => r.create), ...ticketList.map((t) => ({ ticket: t })), ...branchList.filter((r) => !r.create)]
  const current = Math.min(hi, rows.length - 1)
  const go = mode === 'branch' && !racing && check?.level === 'go' ? check.worktree : null
  const ready = !!data && (mode === 'pr' ? !!pr : !check || check.level === 'info' || check.level === 'go')
  const dir = pr ? prDir(pr.number, pr.provider === 'gitlab') : worktreeDir(branch || '...')

  const task = agent ? prompt.trim() : ''
  const canDraft = hasRemote && !!task && mode === 'branch'
  const targetsOf = (req: Request): Target[] => (req.branch === null ? [{ branch: '', agent }] : raceTargets(req.branch, racing ? agents : agents.slice(0, 1)))
  const start = (cwds: string[], targets: Target[]) =>
    launch(view, cwds.map((cwd, i) => ({ cwd, agent: targets[i].agent })), { prompt: task, shell: shellSplit && !!agent, draftPr: draftPr && canDraft })

  /** Adds each target's worktree from `from` on (earlier ones are done), then starts the agents side by side */
  const run = async (req: Request, from = 0) => {
    const targets = targetsOf(req)
    const plan: Step[] = []
    targets.forEach((t, i) => {
      if (i < from) return
      const add = (key: string, label: string, command: string) => plan.push({ key: `${i}:${key}`, label, command, state: 'todo', error: null })
      const tdir = req.pr !== null ? dir : worktreeDir(t.branch)
      if (i === 0 && (req.pr !== null || hasRemote)) add('fetch', req.pr !== null ? `Fetch #${req.pr}` : 'Fetch origin', 'git fetch origin')
      add('add', `Add ${tdir}`, req.pr !== null ? `git worktree add --detach ${tdir} FETCH_HEAD` : `git worktree add ${tdir} ${t.branch}`)
      if (req.copyEnv) add('env', 'Copy .env', 'cp .env')
      if (req.setup) add('setup', 'Run setup', req.setup)
    })
    plan.push({ key: 'open', label: targets.length > 1 ? `Start ${agents.map(cap).join(' and ')} side by side` : agent ? `Start ${cap(agent)}` : 'Open a shell', command: targets.length > 1 ? agents.join(' · ') : (agent ?? 'zsh'), state: 'todo', error: null })
    setSteps((prev) => [...(prev ?? []).filter((x) => Number(x.key.split(':')[0]) < from), ...plan])
    setFailure(null)
    setSent(req)
    for (let i = from; i < targets.length; i++) {
      const onStep = (s: WorktreeStep) => setSteps((all) => all?.map((x) => (x.key === `${i}:${s.step}` ? { ...x, state: STATE[s.state], command: s.command || x.command, error: s.error } : x)) ?? null)
      try {
        paths.current[i] = await api.addWorktree({ ...req, branch: req.branch === null ? null : targets[i].branch, skipFetch: req.skipFetch || i > 0 }, onStep)
      } catch (e: unknown) {
        setFailedAt(i)
        return setFailure(e instanceof Error ? e.message : String(e))
      }
    }
    await start(paths.current.slice(0, targets.length), targets)
    onClose()
  }

  const submit = () => {
    if (!ready || steps) return
    if (go) {
      if (task) void start([go.path], [{ branch, agent }])
      else goTo(view, go.path, agent ?? 'shell')
      return onClose()
    }
    void run({
      repoPath: repo,
      branch: pr ? null : branch,
      base: pr ? null : racing && known ? branch : known ? null : base || null,
      pr: pr?.number ?? null,
      copyEnv: hasEnv && copyEnv,
      setup: setup && runSetup ? setup : null,
      skipFetch: !hasRemote,
    })
  }

  const pick = (row: SuggRow) => {
    setPicking(false)
    if (!('ticket' in row)) return setName(row.name)
    const t = row.ticket
    setName(ticketBranch(t))
    setTicket(t)
    if (prompt.trim()) return
    void api.ticketDetail(t.source, t.key).then(
      (detail) => setPrompt((p) => p.trim() ? p : ticketPrompt(detail)),
      () => setPrompt((p) => p.trim() ? p : `${t.key}: ${t.title}`)
    )
  }

  const onBranchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && picking && rows[current]) pick(rows[current])
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) setHi((current + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    else if (e.key === 'Escape' && picking) setPicking(false)
    else return
    e.preventDefault()
  }

  if (steps && sent) {
    const fetchFailed = steps.some((s) => s.key === '0:fetch' && s.state === 'fail')
    const count = targetsOf(sent).length
    return (
      <Modal className="nw" busy={!failure} onClose={onClose}>
        <h3>
          {sent.pr !== null ? <Glyph name="pr" /> : <Icon name="branch" />}
          {sent.pr !== null ? `Checking out #${sent.pr}` : count > 1 ? `Opening ${count} worktrees` : `Opening ${sent.branch}`}
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
                <button className="btn" onClick={() => void run({ ...sent, skipFetch: true }, failedAt)}>
                  Continue without fetching
                </button>
              )}
              <button className="btn pri" autoFocus onClick={() => void run(sent, failedAt)}>
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
  const label = mode === 'pr' ? 'Check out' : racing ? `Create ${agents.length} worktrees` : go ? (go.path === repo ? 'Open repo folder' : 'Open worktree') : known ? 'Check out' : 'Create worktree'
  const raceOn = !!settings?.features.race && mode === 'branch'
  const toggleAgent = (a: AgentName) => setAgents(agents.includes(a) ? agents.filter((x) => x !== a) : raceOn ? [...agents, a] : [a])

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
          <div className="banner amber">
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
                  {ticketErrors.map((e) => (
                    <div key={e.source} className="mlabel err trunc" title={e.message}>
                      {e.source === 'jira' ? 'Jira' : 'Notion'}: {e.message}
                    </div>
                  ))}
                  {rows.map((r, i) => {
                    const label = 'ticket' in r ? (i === 0 || !('ticket' in rows[i - 1]) ? 'Your tickets' : null) : !r.create && ticketList.length && i > 0 && 'ticket' in rows[i - 1] ? 'Branches' : null
                    return (
                      <div key={'ticket' in r ? `t${r.ticket.source}${r.ticket.key}` : `${r.create}${r.name}`} style={{ display: 'contents' }}>
                        {label && <div className="mlabel">{label}</div>}
                        {'ticket' in r ? (
                          <button className={`mi ${i === current ? 'on' : ''}`} tabIndex={-1} title={`Branch ${ticketBranch(r.ticket)}`} onMouseMove={() => setHi(i)} onClick={() => pick(r)}>
                            <FIcon name={r.ticket.source} />
                            <span className="trunc">
                              <span className="mono dim">{r.ticket.source === 'jira' ? r.ticket.key : r.ticket.project ?? 'Notion'}</span> {r.ticket.title}
                            </span>
                            <span className="d">{r.ticket.status}</span>
                          </button>
                        ) : (
                          <button className={`mi ${i === current ? 'on' : ''}`} tabIndex={-1} onMouseMove={() => setHi(i)} onClick={() => pick(r)}>
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
                        )}
                      </div>
                    )
                  })}
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
        <div className="fld nwtask">
          <label htmlFor="nw-task">
            Task for the agent <span className="dim">optional</span>
            {ticket && <span className="tag mono">{ticket.key}</span>}
          </label>
          <textarea id="nw-task" value={prompt} disabled={!agent} placeholder={agent ? 'What should the agent do in this worktree?' : 'Pick an agent to give it a task'} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <div className="thenopen">
          <span>Then open</span>
          {(['claude', 'codex'] as const).map((a) => (
            <button key={a} className={`tog ${agents.includes(a) ? 'on' : ''}`} onClick={() => toggleAgent(a)}>
              <span className={a}>
                <Icon name={a} />
              </span>
              {cap(a)}
            </button>
          ))}
          <span className="dim" style={{ fontSize: 11 }}>
            {!agent ? 'none: a shell' : racing ? 'both: they race, one worktree each' : raceOn ? 'pick both to race them' : ''}
          </span>
        </div>
        {(((hasEnv || setup) && !go) || agent) && (
          <div className="opts">
            {hasEnv && !go && (
              <label className="chk">
                <input type="checkbox" checked={copyEnv} onChange={(e) => setCopyEnv(e.target.checked)} />
                Copy .env from the repo folder <span className="dim">(git-ignored)</span>
              </label>
            )}
            {setup && !go && (
              <label className="chk">
                <input type="checkbox" checked={runSetup} onChange={(e) => setRunSetup(e.target.checked)} />
                Run setup: <span className="mono">{setup}</span>
              </label>
            )}
            {agent && !go && (
              <label className="chk">
                <input type="checkbox" checked={shellSplit} onChange={(e) => setShellSplit(e.target.checked)} />
                Open a shell split {racing ? 'under each agent' : 'under the agent'}
              </label>
            )}
            {agent && mode === 'branch' && (
              <label className="chk" title={hasRemote ? undefined : 'No remote, so there is nowhere to open it'}>
                <input type="checkbox" checked={draftPr && canDraft} disabled={!canDraft} onChange={(e) => setDraftPr(e.target.checked)} />
                Open a draft PR when the agent finishes {!hasRemote ? <span className="dim">(no remote)</span> : !task && <span className="dim">(needs a task)</span>}
              </label>
            )}
          </div>
        )}
        <div className="mft">
          <span className="dim mono trunc">{go ? go.path : racing ? `${repo}/${dir}-{${agents.join(',')}}` : `${repo}/${dir}`}</span>
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
