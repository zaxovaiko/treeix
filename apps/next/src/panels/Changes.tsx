import { useEffect, useState } from 'react'
import type { DiffScope, FilePatch, GitStatus, Place, PullRequest } from '../ipc/api'
import { Icon } from '../lib/icons'
import type { PanelId } from '../shell/state'
import type { ShellView } from '../shell/Shell'
import { askAgent, Head, NoFolder, PIcon, runIn } from './common'
import { parseHunks, STATUS_CLASS, STATUS_LETTER } from './logic'

const GONE = new Set(['exited', 'restored', 'crashed'])

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
/** Safe inside a double-quoted shell string */
const quoted = (text: string) => text.replace(/["$`\\]/g, '\\$&')

interface Sent {
  key: string
  text: string
  to: string
}

/** Keyed by the place's path, so switching places starts fresh */
export function Changes({ view, place, status, tick, prs, onPanel }: { view: ShellView; place: Place; status: GitStatus | null; tick: number; prs: PullRequest[]; onPanel: (id: PanelId) => void }) {
  const { api } = view
  const root = place.path
  const [pick, setPick] = useState<DiffScope>('base')
  const [patches, setPatches] = useState<FilePatch[]>([])
  const [file, setFile] = useState<string | null>(null)
  const [comment, setComment] = useState<{ key: string; text: string } | null>(null)
  const [sent, setSent] = useState<Sent[]>([])
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onBase = !status?.base || status.branch === status.base
  const scope: DiffScope = onBase ? 'local' : pick

  useEffect(() => {
    if (!status) return
    let live = true
    void api.diff(root, scope).then(
      (list) => live && setPatches(list),
      () => live && setPatches([]),
    )
    return () => void (live = false)
  }, [api, root, scope, status, tick])

  if (place.kind === 'scratch')
    return (
      <>
        <Head title="Changes" place={place} />
        <NoFolder view={view} what="is no git history" />
      </>
    )
  if (!status)
    return (
      <>
        <Head title="Changes" place={place} />
        <div className="banner sky">
          <Icon name="folder" />
          <span className="grow">
            <b>Not a git repository.</b> No branches, diffs or PRs.
          </span>
        </div>
        <div className="grow" />
        <div className="cfoot">
          <button className="btn sm" onClick={() => void runIn(view, root, 'git init')}>
            <Icon name="branch" />
            git init
          </button>
          <span className="dim" style={{ fontSize: 11, alignSelf: 'center' }}>
            turns it into a repo: diffs, worktrees
          </span>
        </div>
      </>
    )

  const attempt = (call: Promise<void>) => call.then(() => setError(null), (e: unknown) => setError(String(e)))
  const local = status.changes
  const conflicts = new Set(status.conflicts)
  const current = patches.find((p) => p.path === file) ?? patches[0]
  const branch = status.branch
  const detached = branch === null
  const pr = prs.find((p) => p.repoPath === place.repoRoot && p.sourceBranch === branch && p.state === 'open')
  const gitlab = prs.some((p) => p.repoPath === place.repoRoot && p.provider === 'gitlab')
  const additions = patches.reduce((n, p) => n + p.additions, 0)
  const deletions = patches.reduce((n, p) => n + p.deletions, 0)

  /** Live agent in this place gets the comment; otherwise a new Claude starts with it */
  const agentHere = Object.values(view.sessions).find((s) => (s.kind === 'claude' || s.kind === 'codex') && !GONE.has(s.status) && view.placeOf(s.id).key === place.key)
  const sendComment = (path: string, line: number) => {
    const text = comment?.text.trim()
    const key = comment?.key
    setComment(null)
    if (!text || !key) return
    const prompt = `Review comment on ${path} (line ${line}): ${text}`
    if (agentHere) {
      void api.write(agentHere.id, `${prompt}\r`)
      view.dispatch({ type: 'focus', session: agentHere.id })
    } else void askAgent(view, 'claude', root, prompt, `Review comments: ${baseName(path)}`)
    setSent([...sent, { key, text, to: agentHere ? agentHere.title : 'new Claude session' }])
  }

  const commitMessage = `Update ${baseName(local[0]?.path ?? 'files')}${local.length > 1 ? ` and ${local.length - 1} more` : ''}`
  const push =
    status.upstream === null
      ? { label: 'Publish branch', command: `git push -u origin ${branch ?? ''}`, ok: !detached && !status.rebase }
      : { label: `Push ⇡${status.ahead}`, command: 'git push', ok: status.ahead > 0 && !detached && !status.rebase }

  const hunks = current ? parseHunks(current.patch) : []
  return (
    <>
      <Head title="Changes" place={place}>
        {onBase ? (
          <span className="tag" title={`On ${status.base ?? 'the base branch'} there is no base to compare with`}>
            uncommitted only
          </span>
        ) : (
          <div className="seg">
            <button className={scope === 'base' ? 'on' : ''} onClick={() => setPick('base')}>
              vs {status.base}
            </button>
            <button className={scope === 'local' ? 'on' : ''} onClick={() => setPick('local')}>
              Uncommitted{local.length ? ` ${local.length}` : ''}
            </button>
          </div>
        )}
      </Head>
      {status.merged && place.kind === 'worktree' && (
        <div className="banner violet">
          <PIcon name="pr" />
          <span className="grow">
            <b>{branch} is merged.</b> The branch and worktree can go.
          </span>
          <button className="btn sm" onClick={() => view.openDialog({ kind: 'worktrees', cleanup: true })}>
            Clean up
          </button>
        </div>
      )}
      {status.rebase && (
        <div className="banner red">
          <Icon name="alert" />
          <div className="grow">
            <b>
              Rebase {status.rebase.step}/{status.rebase.total} stopped on conflicts
            </b>
            <div className="conf">
              {status.conflicts.length ? (
                status.conflicts.map((f) => (
                  <span key={f} className="flink gs-C" onClick={() => view.openFile(root, f)}>
                    ! {f}
                  </span>
                ))
              ) : (
                <span className="ok">All conflicts resolved</span>
              )}
            </div>
            <div className="a">
              <button
                className="btn sm pri"
                disabled={!status.conflicts.length}
                onClick={() => void askAgent(view, 'claude', root, `Resolve the rebase conflicts in ${status.conflicts.join(', ')}. Keep both sides' intent, then git add them.`, 'Resolve rebase conflicts')}
              >
                <Icon name="claude" />
                Ask Claude to resolve
              </button>
              <button className="btn sm" onClick={() => void runIn(view, root, 'git rebase --abort')}>
                Abort
              </button>
              <button className="btn sm" disabled={status.conflicts.length > 0} title={status.conflicts.length ? 'Resolve every conflict first' : undefined} onClick={() => void runIn(view, root, 'git rebase --continue')}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
      {status.behind > 0 && !detached && (
        <div className="banner amber">
          <Icon name="down" />
          <span className="grow">
            {status.behind} new commit{status.behind === 1 ? '' : 's'} on {status.upstream}
          </span>
          <button className="btn sm" onClick={() => void runIn(view, root, 'git pull')}>
            Pull ⇣{status.behind}
          </button>
        </div>
      )}
      {error && (
        <div className="banner red">
          <Icon name="alert" />
          <span className="grow">{error}</span>
        </div>
      )}
      <div className="dim psum">
        {scope === 'base' ? `${branch ?? status.head} → ${status.base}` : 'uncommitted'} · {patches.length} files <span className="ok">+{additions}</span> <span className="err">-{deletions}</span>
      </div>
      <div className="clist">
        {patches.length ? (
          patches.map((p) => {
            const s = conflicts.has(p.path) ? 'conflicted' : p.status
            const dirty = local.some((c) => c.path === p.path)
            return (
              <div key={p.path} className={`crow ${p.path === current?.path ? 'on' : ''}`} onClick={() => setFile(p.path)} title={p.oldPath ? `${p.oldPath} → ${p.path}` : p.path}>
                <span className={`s ${STATUS_CLASS[s]}`}>{STATUS_LETTER[s]}</span>
                <span className="grow trunc">
                  <span className={STATUS_CLASS[s]}>{baseName(p.path)}</span> <span className="d">{dirName(p.path)}</span>
                </span>
                {dirty &&
                  (confirm === p.path ? (
                    <button
                      className="btn sm danger"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirm(null)
                        void attempt(api.discardChanges(root, p.path))
                      }}
                    >
                      Discard?
                    </button>
                  ) : (
                    <button
                      className="icon sm discard"
                      title="Discard changes"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirm(p.path)
                      }}
                    >
                      <PIcon name="undo" />
                    </button>
                  ))}
                <span className="num ok">{p.additions ? `+${p.additions}` : ''}</span>
                <span className="num err">{p.deletions ? `-${p.deletions}` : ''}</span>
              </div>
            )
          })
        ) : (
          <div className="empty">{scope === 'local' ? 'Working tree clean' : `No commits on top of ${status.base} yet`}</div>
        )}
      </div>
      <div className="pscroll">
        {current && !hunks.length && <div className="empty">{current.patch ? 'No textual changes' : 'Binary file'}</div>}
        {current &&
          hunks.map((hunk, hi) => (
            <div key={hi} className="hunk">
              <div className="hh">{hunk.header}</div>
              {hunk.lines.map((line, li) => {
                const key = `${current.path}:${hi}:${li}`
                return (
                  <div key={li}>
                    <div className={`dl ${line.kind === '+' ? 'a' : line.kind === '-' ? 'd' : ''}`}>
                      <button className="cmt" title="Comment for the agent" onClick={() => setComment({ key, text: '' })}>
                        <Icon name="plus" />
                      </button>
                      <span className="o">{line.old}</span>
                      <span className="n">{line.new}</span>
                      <span className="t">
                        {line.kind} {line.text}
                      </span>
                    </div>
                    {sent
                      .filter((s) => s.key === key)
                      .map((s, i) => (
                        <div key={i} className="thread sent">
                          <PIcon name="comment" />
                          <span className="grow">{s.text}</span>
                          <span className="tag violet trunc">sent to {s.to}</span>
                        </div>
                      ))}
                    {comment?.key === key && (
                      <div className="thread">
                        <textarea
                          autoFocus
                          placeholder="Tell the agent what to change here"
                          value={comment.text}
                          onChange={(e) => setComment({ key, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendComment(current.path, line.new ?? line.old ?? 0)
                            if (e.key === 'Escape') setComment(null)
                          }}
                        />
                        <div className="a">
                          <button className="btn sm pri" onClick={() => sendComment(current.path, line.new ?? line.old ?? 0)}>
                            <PIcon name="send" />
                            {agentHere ? `Send to ${agentHere.title.slice(0, 24)}` : 'Start Claude with this'}
                          </button>
                          <button className="btn sm" onClick={() => setComment(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
      </div>
      <div className="cfoot">
        <button
          className="btn sm"
          disabled={!local.length || !!status.rebase || detached}
          title={detached ? 'Detached HEAD: create a branch first' : local.length ? undefined : 'Nothing to commit'}
          onClick={() => void runIn(view, root, `git commit -am "${quoted(commitMessage)}"`)}
        >
          Commit
        </button>
        <button className="btn sm" disabled={!push.ok} onClick={() => void runIn(view, root, push.command)}>
          {push.label}
        </button>
        {!onBase && !status.merged && pr ? (
          <button className="btn sm" onClick={() => onPanel('prs')}>
            <PIcon name="pr" />#{pr.number}
          </button>
        ) : (
          !onBase &&
          !status.merged &&
          !detached && (
            <button className="btn sm" onClick={() => void runIn(view, root, gitlab ? 'glab mr create --draft --fill' : 'gh pr create --draft --fill')}>
              <PIcon name="pr" />
              Open {gitlab ? 'MR' : 'PR'}
            </button>
          )
        )}
        <span className="grow" />
        {!onBase && patches.length > 0 && (
          <button className="btn sm" onClick={() => void askAgent(view, 'claude', root, `Review the changes in ${branch ?? status.head} against ${status.base}.`, `Review ${branch ?? status.head}`)}>
            <Icon name="claude" />
            Ask Claude to review
          </button>
        )}
      </div>
    </>
  )
}
