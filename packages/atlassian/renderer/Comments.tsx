import { useState } from 'react'
import { Kbd, useHost } from '@treeix/sdk'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { timeAgo } from '@treeix/app/time'
import { errorMessage, UserAvatar } from '@treeix/app/ui'
import { type AtlassianComment, IMAGE_HOST } from '../shared'

export type CommentActions = {
  add: (body: string, replyTo: AtlassianComment | null) => Promise<void>
  edit: (comment: AtlassianComment, body: string) => Promise<void>
  remove: (comment: AtlassianComment) => Promise<void>
}

type Shared = {
  actions: CommentActions
  resolveImage: (src: string) => Promise<string> | null
  onChanged: () => void
  /** Whether edit and delete show; everyone's when absent */
  isMine?: (comment: AtlassianComment) => boolean
  /** Queues the comment for an agent */
  onAgent?: (comment: AtlassianComment) => void
}

/** Comments and every reply under them */
export const commentCount = (comments: AtlassianComment[]): number => comments.reduce((total, comment) => total + 1 + commentCount(comment.replies ?? []), 0)

/** Writes plain text; Cmd+Enter sends, Escape cancels when there is something to go back to */
function CommentBox({
  id,
  placeholder,
  initial = '',
  label,
  onSubmit,
  onCancel
}: {
  id?: string
  placeholder: string
  initial?: string
  label: string
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
}): React.JSX.Element {
  const host = useHost()
  const [body, setBody] = useState(initial)
  const [sending, setSending] = useState(false)
  const send = (): void => {
    if (!body.trim() || sending) return
    setSending(true)
    onSubmit(body.trim())
      .then(() => setBody(''), (reason: unknown) => host.flash(errorMessage(reason)))
      .finally(() => setSending(false))
  }
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <textarea
        id={id}
        value={body}
        autoFocus={onCancel !== undefined}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') send()
          else if (event.key === 'Escape' && onCancel) {
            event.stopPropagation()
            onCancel()
          }
        }}
        placeholder={placeholder}
        rows={body || onCancel ? 4 : 1}
        className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
      />
      {(body || onCancel) && (
        <div className="mt-1 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-muted-foreground">Plain text</span>
          {onCancel && (
            <button onClick={onCancel} className="flex h-7 items-center rounded-md px-3 text-xs hover:bg-accent">
              Cancel
            </button>
          )}
          <button onClick={send} disabled={sending || !body.trim()} className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
            {sending ? 'Sending...' : label}
            <Kbd hint>⌘↵</Kbd>
          </button>
        </div>
      )}
    </div>
  )
}

const ACTION = 'rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40'

function CommentCard({ comment, ...shared }: Shared & { comment: AtlassianComment }): React.JSX.Element {
  const { actions, resolveImage, onChanged, isMine, onAgent } = shared
  const host = useHost()
  const mine = isMine?.(comment) ?? true
  const [mode, setMode] = useState<'view' | 'edit' | 'reply'>('view')
  const [removing, setRemoving] = useState(false)
  // Saving plain text over an attachment image would leave a dead placeholder link in its place
  const hasImages = comment.body.includes(IMAGE_HOST)
  const remove = (): void => {
    if (!window.confirm(`Delete this comment by ${comment.author}?`)) return
    setRemoving(true)
    actions
      .remove(comment)
      .then(onChanged, (reason: unknown) => host.flash(errorMessage(reason)))
      .finally(() => setRemoving(false))
  }
  const done = (): void => {
    setMode('view')
    onChanged()
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="group rounded-lg border border-border bg-card px-4 py-3">
        <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs">
          <UserAvatar name={comment.author} url={comment.authorAvatar} size="size-5" />
          <span className="truncate font-medium">{comment.author}</span>
          <span className="shrink-0 text-muted-foreground">{timeAgo(comment.created)} ago</span>
          <span className="flex-1" />
          {/* Comments cached before ids were kept can't be changed until the item reloads */}
          {comment.id && mode === 'view' && (
            <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
              {onAgent && (
                <button onClick={() => onAgent(comment)} className={ACTION}>
                  Add to agent
                </button>
              )}
              <button onClick={() => setMode('reply')} className={ACTION}>
                Reply
              </button>
              {mine && (
                <>
                  <button onClick={() => setMode('edit')} disabled={hasImages} title={hasImages ? 'Has images, which editing here would drop' : undefined} className={ACTION}>
                    Edit
                  </button>
                  <button onClick={remove} disabled={removing} className={ACTION}>
                    {removing ? 'Deleting...' : 'Delete'}
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        {mode === 'edit' ? (
          <CommentBox placeholder="Comment" initial={comment.body} label="Save" onSubmit={(body) => actions.edit(comment, body).then(done)} onCancel={() => setMode('view')} />
        ) : (
          <Markdown resolveImage={resolveImage}>{comment.body}</Markdown>
        )}
      </div>
      {(comment.replies?.length || mode === 'reply') && (
        <div className="ml-6 flex flex-col gap-2">
          {comment.replies?.map((reply) => <CommentCard key={reply.id} comment={reply} {...shared} />)}
          {mode === 'reply' && <CommentBox placeholder={`Reply to ${comment.author}`} label="Reply" onSubmit={(body) => actions.add(body, comment).then(done)} onCancel={() => setMode('view')} />}
        </div>
      )}
    </div>
  )
}

/** Comments with reply, edit and delete, and a box for a new one; `inputId` lets a shortcut focus that box */
export function Comments({ comments, target, inputId, title, ...shared }: Shared & { comments: AtlassianComment[]; target: string; inputId?: string; title: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      {title}
      {comments.map((comment, index) => (
        <CommentCard key={comment.id || `${comment.created}:${index}`} comment={comment} {...shared} />
      ))}
      <CommentBox key={target} id={inputId} placeholder={`Comment on ${target}`} label="Comment" onSubmit={(body) => shared.actions.add(body, null).then(shared.onChanged)} />
    </section>
  )
}
