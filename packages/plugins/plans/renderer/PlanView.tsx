import { useEffect, useState } from 'react'
import { type Attachment, formatComments, type LineRange, type ReviewComment } from '@treeix/shared/comments'
import type { Repo } from '@treeix/shared/types'
import type { Plan } from '../shared/types'
import { readPlan } from './api'
import { FileView } from '@treeix/app/FileView'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { timeAgo } from '@treeix/app/time'
import { SendButton } from '@treeix/app/SendButton'
import { EmptyState, usePersisted } from '@treeix/app/ui'

const POLL_MS = 3000

export function PlanView({
  plan,
  repos,
  comments,
  sendFrom,
  onAddComment,
  onDeleteComment,
  onClearComments,
  onDone
}: {
  plan: Plan
  repos: Repo[] | null
  comments: ReviewComment[]
  /** Worktree whose sessions are suggested first when sending comments */
  sendFrom: string
  onAddComment: (range: LineRange, code: string, text: string, attachments: Attachment[]) => void
  onDeleteComment: (comment: ReviewComment) => void
  onClearComments: () => void
  onDone: (message: string) => void
}): React.JSX.Element {
  const [markdown, setMarkdown] = useState<string | null | undefined>(undefined)
  const [mode, setMode] = usePersisted<'source' | 'preview'>('plan.mode', 'source')

  // Agents keep editing the plan after you open it
  useEffect(() => {
    const load = (): void => {
      readPlan(plan.name).then((next) => setMarkdown((current) => (current === next ? current : next)))
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [plan.name])

  const prompt = (): string =>
    `Review comments on the plan ${plan.path}. Update the plan to address each one:\n\n${formatComments(comments)}\n`

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name="file" className="size-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium">{plan.title}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={plan.path}>
          {plan.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">· updated {timeAgo(new Date(plan.modifiedAt).toISOString())} ago</span>
        <span className="flex-1" />
        {mode === 'source' && <span className="truncate text-[11px] text-muted-foreground">Drag lines to comment</span>}
        <div className="flex shrink-0 rounded-md border border-border bg-muted p-0.5">
          {(['source', 'preview'] as const).map((value) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`rounded-[5px] px-2 py-0.5 text-xs ${
                mode === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {value === 'source' ? 'Source' : 'Preview'}
            </button>
          ))}
        </div>
      </div>

      {markdown === undefined && <EmptyState fill title="Loading..." />}
      {markdown === null && <EmptyState fill icon="file" title="This plan no longer exists" />}
      {typeof markdown === 'string' && mode === 'source' && (
        <FileView
          worktreePath={plan.path}
          path={plan.name}
          line={null}
          contents={markdown}
          comments={comments}
          onNavigate={() => undefined}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
        />
      )}
      {typeof markdown === 'string' && mode === 'preview' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {comments.length > 0 && (
            <p className="mx-auto mt-4 max-w-3xl px-6 text-xs text-muted-foreground">
              {comments.length} comment{comments.length === 1 ? '' : 's'} · switch to Source to see them on their lines
            </p>
          )}
          <div className="mx-auto max-w-3xl px-6 py-6 text-[14px]">
            <Markdown>{markdown}</Markdown>
          </div>
        </div>
      )}

      {comments.length > 0 && (
        <div className="absolute right-4 bottom-4 z-30">
          <SendButton
            repos={repos}
            worktreePath={sendFrom}
            count={comments.length}
            prompt={prompt}
            variant="pill"
            onDone={onDone}
            onClear={onClearComments}
          />
        </div>
      )}
    </div>
  )
}
