import { Fragment, useEffect, useState } from 'react'
import type { ChangeStatus, GitStatus } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import type { ShellView } from '../../shell/Shell'
import { CommentsDrawer } from './CommentCards'
import { askAgent } from '../../panels/common'
import { clearComments, reviewPrompt, useComments } from './comments'
import { FileIcon } from './icons'
import { IMAGE_PATH, Media, PDF_PATH } from './Media'
import { closeFile, closeFileLeaf, leafRoot, openFile, showFile, useFileTabs } from './open'
import { TextFile, type SaveStatus } from './TextFile'
import '../../styles/file.css'

const STATUS_CLASS: Record<ChangeStatus, string> = { modified: 'gs-M', renamed: 'gs-M', added: 'gs-A', untracked: 'gs-A', deleted: 'gs-D', conflicted: 'gs-U' }
const SAVE_LABEL: Record<SaveStatus, string> = { saved: 'Saved', pending: 'Unsaved', saving: 'Saving...', failed: 'Save failed' }

/** A place's open files as editor tabs over one editor, a diff against HEAD, and the place's comments for agents */
const GONE = new Set(['exited', 'restored', 'crashed'])

export function FilePane({ view, id }: { view: ShellView; id: string }) {
  const { api } = view
  const root = leafRoot(id)
  const tabs = useFileTabs(id)
  const file = tabs?.active ?? null
  const [git, setGit] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [save, setSave] = useState<{ status: SaveStatus; error: string | null }>({ status: 'saved', error: null })
  const comments = useComments().filter((comment) => comment.worktreePath === root)
  const text = file !== null && !IMAGE_PATH.test(file) && !PDF_PATH.test(file)
  /** A live agent in this place gets the queue; otherwise a new Claude starts with it */
  const agent = Object.values(view.sessions).find((s) => (s.kind === 'claude' || s.kind === 'codex') && !GONE.has(s.status) && view.placeOf(s.id).path === root)
  const sendComments = () => {
    const prompt = reviewPrompt(comments)
    if (agent)
      void api
        .write(agent.id, `\x1b[200~${prompt}\x1b[201~`)
        .then(() => api.write(agent.id, '\r'))
        .then(() => view.dispatch({ type: 'focus', session: agent.id }))
    else void askAgent(view, 'claude', root, prompt, 'Review comments')
    clearComments(root)
    setDrawer(false)
  }

  // Tab colors and the gutter's base follow saves
  const saved = save.status === 'saved'
  useEffect(() => {
    if (!saved) return
    let stale = false
    api.gitStatus(root).then(
      (status) => stale || setGit(status),
      () => stale || setGit(null)
    )
    return () => void (stale = true)
  }, [api, root, saved])

  if (!tabs || file === null) {
    return (
      <div className="empty fv-fill">
        No file open
        <button className="btn sm" onClick={() => closeFileLeaf(view, id)}>Close pane</button>
      </div>
    )
  }

  const statusOf = (path: string) => git?.changes.find((change) => change.path === path)?.status
  const parts = file.split('/')
  const fileComments = comments.filter((comment) => comment.filePath === file)
  return (
    <div className="ed">
      <div className="edtabs">
        {tabs.files.map((path) => {
          const status = statusOf(path)
          return (
            <div key={path} className={`edtab ${path === file ? 'on' : ''}`} title={path} onMouseDown={(e) => e.button === 1 && closeFile(view, id, path)} onClick={() => showFile(id, path)}>
              <FileIcon name="file" />
              <span className={status ? STATUS_CLASS[status] : ''}>{path.split('/').pop()}</span>
              <button className="icon sm" title="Close file" onClick={(e) => (e.stopPropagation(), closeFile(view, id, path))}>
                <Icon name="x" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="edcrumb">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <Icon name="right" />}
            <span className={i === parts.length - 1 ? 'fv-name' : ''}>{part}</span>
          </Fragment>
        ))}
        <span className="grow" />
        {text && git?.base && !diff && <span className="dim hint">gutter: diff vs {git.base} · click ▸ to peek removed lines</span>}
        {text && (
          <span className={`fv-save ${save.status}`} title={save.error ?? undefined}>
            {SAVE_LABEL[save.status]}
          </span>
        )}
        {text && git && (
          <div className="seg">
            <button className={diff ? '' : 'on'} onClick={() => setDiff(false)}>Edit</button>
            <button className={diff ? 'on' : ''} onClick={() => setDiff(true)} title="Changes against HEAD">Diff</button>
          </div>
        )}
        <button className={`btn sm ghost ${drawer ? 'on' : ''}`} onClick={() => setDrawer(!drawer)} title="Comments for agents">
          <FileIcon name="comment" />
          {comments.length || ''}
        </button>
        {git && (
          <button className="btn sm ghost" onClick={() => view.openDialog({ kind: 'fileHistory', root, file })}>
            <FileIcon name="history" />
            History
          </button>
        )}
      </div>
      <div className="fv-main">
        {text ? (
          <TextFile
            key={`${root}\0${file}`}
            api={api}
            root={root}
            file={file}
            base={git?.base ?? null}
            reveal={tabs.reveal}
            diff={diff}
            comments={fileComments}
            onStatus={(status, error) => setSave({ status, error })}
          />
        ) : (
          <Media key={file} api={api} root={root} file={file} />
        )}
        {drawer && (
          <CommentsDrawer
            root={root}
            comments={comments}
            sendTo={agent ? (agent.kind === 'codex' ? 'Codex' : 'Claude') : 'a new Claude'}
            onSend={sendComments}
            onOpen={(comment) => (setDiff(false), openFile(view, root, comment.filePath, comment.range.end))}
            onClose={() => setDrawer(false)}
          />
        )}
      </div>
    </div>
  )
}
