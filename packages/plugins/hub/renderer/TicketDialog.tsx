import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown } from '@treeix/app/LazyMarkdown'
import { Dialog, errorMessage } from '@treeix/app/ui'
import type { TicketDetail, TicketSource } from '../shared/workflow'
import { useEscape } from './AskDialog'
import { hubApi } from './store'

export type TicketMode = 'preview' | 'edit' | 'comment'

const button = 'h-7 rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent disabled:opacity-50'
const primary = 'h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50'

/** A run's Jira work item or Notion page: its whole text, edited in place, and comments its workflow's agents read */
export function TicketDialog({ source, ticketKey, mode, onClose }: { source: TicketSource; ticketKey: string; mode: TicketMode; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(mode === 'edit')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  useEscape(onClose)

  const load = (): void =>
    void hubApi.ticket(source, ticketKey).then(
      (loaded) => {
        setDetail(loaded)
        setTitle(loaded.title)
        setBody(loaded.body)
      },
      (reason: unknown) => setError(errorMessage(reason))
    )
  useEffect(load, [source, ticketKey])

  const act = (action: Promise<unknown>, done: () => void): void => {
    setBusy(true)
    setError(null)
    action.then(
      () => (setBusy(false), done()),
      (reason: unknown) => (setBusy(false), setError(errorMessage(reason)))
    )
  }
  const save = (): void => {
    if (!detail) return
    const changes = { ...(title.trim() !== detail.title ? { title: title.trim() } : {}), ...(body !== detail.body ? { body } : {}) }
    if (!Object.keys(changes).length) return setEditing(false)
    act(hubApi.editTicket(source, ticketKey, changes), () => (setEditing(false), load()))
  }
  const send = (): void => {
    if (!comment.trim()) return
    act(hubApi.commentTicket(source, ticketKey, comment.trim()), () => {
      setComment('')
      host.flash(`Commented on ${source === 'jira' ? ticketKey : 'the page'}`)
      load()
    })
  }

  return (
    <Dialog onClose={onClose} offset="pt-[10vh]" className="flex max-h-[80vh] w-[720px] max-w-[92vw] flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name={source === 'jira' ? 'ticket' : 'bookOpen'} className="size-3.5 shrink-0 text-muted-foreground" />
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Title"
            className="h-7 min-w-0 flex-1 rounded-md bg-muted/40 px-2 text-sm ring-1 ring-border outline-none focus:ring-primary"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{detail?.title || ticketKey}</span>
        )}
        {detail?.url && (
          <button onClick={() => window.open(detail.url ?? '', '_blank')} className="text-[11px] text-primary hover:underline">
            Open in {source === 'jira' ? 'Jira' : 'Notion'}
          </button>
        )}
        {detail && !editing && (
          <button onClick={() => setEditing(true)} className={button}>
            Edit
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!detail && !error && <p className="text-xs text-muted-foreground">Loading…</p>}
        {detail &&
          (editing ? (
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              aria-label="Description"
              rows={18}
              className="w-full resize-y rounded-md bg-muted/40 p-2 font-mono text-xs ring-1 ring-border outline-none focus:ring-primary"
            />
          ) : (
            <div className="text-sm select-text">
              {detail.body.trim() ? <LazyMarkdown>{detail.body}</LazyMarkdown> : <p className="text-xs text-muted-foreground">No description</p>}
            </div>
          ))}
        {detail && !editing && detail.comments.length > 0 && (
          <section className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
            {detail.comments.map((entry, index) => (
              <div key={index} className="flex flex-col gap-1">
                <div className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{entry.author}</span> · {new Date(entry.created).toLocaleString()}
                </div>
                <div className="text-xs select-text">
                  <LazyMarkdown>{entry.body}</LazyMarkdown>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
      {error && <p className="px-4 pb-2 text-xs text-red-400 select-text">{error}</p>}
      <footer className="flex items-end gap-2 border-t border-border p-2">
        {editing ? (
          <>
            <span className="flex-1" />
            <button onClick={() => (setEditing(false), detail && (setTitle(detail.title), setBody(detail.body)))} className={button}>
              Cancel
            </button>
            <button onClick={save} disabled={busy || !title.trim()} className={primary}>
              Save to {source === 'jira' ? 'Jira' : 'Notion'}
            </button>
          </>
        ) : (
          <>
            <textarea
              autoFocus={mode === 'comment'}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
                event.preventDefault()
                send()
              }}
              rows={2}
              aria-label="Comment"
              placeholder="Comment on the ticket; the agent reads it on its next run or retry"
              className="max-h-40 min-h-7 flex-1 resize-none rounded-md bg-muted/40 px-2 py-1.5 text-xs ring-1 ring-border outline-none placeholder:text-muted-foreground/60 focus:ring-primary"
            />
            <button onClick={send} disabled={busy || !comment.trim()} className={primary}>
              Comment
            </button>
          </>
        )}
      </footer>
    </Dialog>
  )
}
