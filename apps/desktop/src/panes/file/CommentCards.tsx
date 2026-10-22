import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { clearComments, deleteComment, linesLabel, type ReviewComment } from './comments'
import { FileIcon } from './icons'

export function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <div className="fv-card">
      <FileIcon name="comment" />
      <div className="grow">
        <div className="dim">{linesLabel(comment.range)}</div>
        <div className="fv-text">{comment.text}</div>
      </div>
      <button className="icon sm" title="Delete comment" onClick={() => deleteComment(comment.id)}>
        <Icon name="x" />
      </button>
    </div>
  )
}

/** ⌘⏎ saves, Esc cancels */
export function CommentDraft({ label, onSave, onCancel }: { label: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  // The gutter click that opened the draft hands focus back to the editor on mouseup; take it after that
  useEffect(() => {
    const frame = requestAnimationFrame(() => box.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  const save = () => text.trim() && onSave(text.trim())
  return (
    <div className="fv-card draft">
      <div className="grow">
        <div className="dim">{label}</div>
        <textarea
          ref={box}
          rows={3}
          value={text}
          placeholder="Note for the agent"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          }}
        />
        <div className="fv-row">
          <span className="grow" />
          <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
          <button className="btn sm pri" disabled={!text.trim()} onClick={save}>Comment</button>
        </div>
      </div>
    </div>
  )
}

/** The place's comments for agents, by file; a click opens the file at the comment */
export function CommentsDrawer({
  root,
  comments,
  sendTo,
  onSend,
  onOpen,
  onClose,
}: {
  root: string
  comments: ReviewComment[]
  /** Who gets the queue, like `Claude` or `a new Claude` */
  sendTo: string
  onSend: () => void
  onOpen: (comment: ReviewComment) => void
  onClose: () => void
}) {
  const files = [...new Set(comments.map((comment) => comment.filePath))]
  return (
    <aside className="fv-drawer">
      <div className="fv-dhd">
        <FileIcon name="comment" />
        <span className="grow">Comments for agents</span>
        <button className="icon sm" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="fv-dlist">
        {!comments.length && <div className="empty">No comments yet. Click + beside a line number to add one.</div>}
        {files.map((file) => (
          <div key={file}>
            <div className="fv-dfile trunc">{file}</div>
            {comments
              .filter((comment) => comment.filePath === file)
              .map((comment) => (
                <div key={comment.id} className="mi" onClick={() => onOpen(comment)}>
                  <div className="grow">
                    <div className="fv-text">{comment.text}</div>
                    <div className="dim">{linesLabel(comment.range)}</div>
                  </div>
                  <button className="icon sm" title="Delete comment" onClick={(e) => (e.stopPropagation(), deleteComment(comment.id))}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
          </div>
        ))}
      </div>
      {comments.length > 0 && (
        <div className="fv-dft">
          <button className="btn sm ghost" onClick={() => clearComments(root)}>Clear the list</button>
          <button className="btn sm pri" onClick={onSend}>
            Send {comments.length} to {sendTo}
          </button>
        </div>
      )}
    </aside>
  )
}
