import { useEffect, useRef, useState } from 'react'
import { Kbd, ListToggle, useHost } from '@treeix/sdk'
import { copyText } from '@treeix/app/contextMenu'
import { Icon } from '@treeix/app/Icon'
import { LazyMarkdown as Markdown, MarkdownFoldButton, MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import { LinkPreviews } from '@treeix/app/LinkPreviews'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import { CopyButton, EmptyState, errorMessage, UserAvatar } from '@treeix/app/ui'
import type { Repo, Worktree } from '@treeix/shared/types'
import { useCached } from '@treeix/atlassian/renderer/cache'
import type { Epic, JiraPerson, WorkItem, WorkItemDetail } from '../shared/types'
import { detailCache, jiraApi, resolveImage, selection, TTL } from './api'
import { branchFor, isBranchFor } from './branch'
import { Picker } from './Picker'
import { EpicChip, PriorityMark, StatusPill, TypeMark } from './marks'

export type StatusOption = { name: string; category: WorkItem['statusCategory'] }
export type PickerId = 'status' | 'assignee' | 'type' | 'repo' | 'sort'

/** Fields the keyboard reaches by id: l adds a label, c comments */
export const LABEL_INPUT = 'ticket-label-input'
export const COMMENT_INPUT = 'ticket-comment-input'

const CATEGORY_LABELS: Record<WorkItem['statusCategory'], string> = { new: 'To do', indeterminate: 'In progress', done: 'Done' }
const UNASSIGN = '-'
const MYSELF = '@me'

export type Ticket = NonNullable<ReturnType<typeof useTicket>>

/**
 * Everything the detail of the selected item does. Every edit shows its result at once and runs in the
 * background; if Jira refuses, the change is taken back and the reason stays on screen until dismissed.
 */
export function useTicket(
  item: WorkItem | undefined,
  {
    statuses,
    people,
    myName,
    setPicker,
    onPatch,
    onChanged
  }: {
    statuses: StatusOption[]
    people: JiraPerson[]
    myName: string | null
    setPicker: (picker: PickerId | null) => void
    /** Shows fields as changed right away; the returned function takes the change back */
    onPatch: (key: string, fields: Partial<WorkItem>) => () => void
    onChanged: () => void
  }
) {
  const host = useHost()
  const key = item?.key ?? ''
  const { value: detail, error, refresh: reload } = useCached<WorkItemDetail>(detailCache, key, TTL.detail, jiraApi.detail)
  const [failure, setFailure] = useState<string | null>(null)
  /** The item on screen now; an edit that settles after moving on to another item must not touch this one */
  const shownKey = useRef(key)
  shownKey.current = key
  /** Labels as last changed here, until the item reloads with Jira's own */
  const [labels, setLabels] = useState<string[] | null>(null)
  useEffect(() => setLabels(null), [detail])
  useEffect(() => setFailure(null), [key])
  if (!item) return null

  const linked: { repo: Repo; worktree: Worktree }[] = (host.repos ?? []).flatMap((repo) =>
    repo.worktrees.filter((worktree) => isBranchFor(worktree.branch, item.key)).map((worktree) => ({ repo, worktree }))
  )
  const repos = host.scopeRepoPaths ?? []

  const change = (failed: string, work: () => Promise<void>, fields: Partial<WorkItem> = {}, undoLocal?: () => void): void => {
    const undo = onPatch(item.key, fields)
    setFailure(null)
    work().then(
      () => {
        if (shownKey.current === item.key) reload()
        onChanged()
      },
      (reason: unknown) => {
        undo()
        if (shownKey.current !== item.key) return
        undoLocal?.()
        setFailure(`${failed}: ${errorMessage(reason)}`)
      }
    )
  }
  const shownLabels = labels ?? detail?.labels ?? []
  const changeLabels = (next: string[], failed: string, work: () => Promise<void>): void => {
    const before = labels
    setLabels(next)
    change(failed, work, {}, () => setLabels(before))
  }

  const createWorktree = (repoPath: string): void => {
    // Another worktree for the same item gets its own branch: -2, -3 and so on
    const taken = new Set(host.repos?.find((repo) => repo.path === repoPath)?.worktrees.map((worktree) => worktree.branch))
    let branch = branchFor(item)
    for (let count = 2; taken.has(branch); count++) branch = `${branchFor(item)}-${count}`
    host.flash(`Creating worktree ${branch}...`)
    host.createWorktree(repoPath, branch, undefined, host.service('sessions') ? 'claude' : null).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  /** A new worktree even when there are some already, asking which repository when there are several */
  const newWorktree = (): void => {
    if (repos.length === 1) return createWorktree(repos[0])
    if (repos.length === 0) return host.flash('No repository in this workspace')
    setPicker('repo')
  }

  return {
    item,
    detail,
    error,
    reload,
    failure,
    dismissFailure: () => setFailure(null),
    labels: shownLabels,
    linked,
    repos,
    transition: (status: string): void =>
      change(`Couldn't move ${item.key} to ${status}`, () => jiraApi.transition(item.key, status), {
        status,
        statusCategory: statuses.find((option) => option.name === status)?.category ?? item.statusCategory
      }),
    assign: (accountId: string | null): void => {
      const person = accountId === MYSELF ? { name: myName, avatar: null } : people.find((candidate) => candidate.accountId === accountId)
      change(`Couldn't assign ${item.key}`, () => jiraApi.assign(item.key, accountId), {
        assignee: accountId ? (person?.name ?? item.assignee) : null,
        assigneeAvatar: accountId ? (person?.avatar ?? null) : null,
        assigneeId: accountId === MYSELF ? null : accountId
      })
    },
    rename: (summary: string): void => change(`Couldn't rename ${item.key}`, () => jiraApi.edit(item.key, { summary }), { summary }),
    retype: (type: string): void => change(`Couldn't change ${item.key} to ${type}`, () => jiraApi.edit(item.key, { type }), { type }),
    addLabel: (label: string): void =>
      changeLabels([...shownLabels.filter((entry) => entry !== label), label], `Couldn't add ${label}`, () => jiraApi.edit(item.key, { addLabels: [label] })),
    removeLabel: (label: string): void =>
      changeLabels(
        shownLabels.filter((entry) => entry !== label),
        `Couldn't remove ${label}`,
        () => jiraApi.edit(item.key, { removeLabels: [label] })
      ),
    createWorktree,
    newWorktree,
    /** The worktree already made for the item, else a new one */
    openWorktree: (): void => (linked[0] ? host.openWorktree(linked[0].worktree.path) : newWorktree()),
    addToComments: (): void => {
      // The item's worktree, the selected one when it is among them
      const worktreePath = (linked.find(({ worktree }) => worktree.path === host.selectedWorktree) ?? linked[0])?.worktree.path ?? host.selectedWorktree
      if (!worktreePath) return host.flash('Select a worktree first')
      const filePath = `${item.key} ${item.summary}`
      if (host.comments.some((comment) => comment.worktreePath === worktreePath && comment.filePath === filePath)) {
        return host.flash(`${item.key} is already in the comments on ${baseName(worktreePath)}`)
      }
      host.addComment({
        id: crypto.randomUUID(),
        worktreePath,
        filePath,
        range: { start: 0, end: 0 },
        code: '',
        // Only the reference: the agent reads the ticket itself, so the prompt stays short and up to date
        text: `Jira ${item.key}${item.url ? ` ${item.url}` : ''}`,
        kind: 'reference'
      })
      host.flash(`Added ${item.key} to comments on ${baseName(worktreePath)}`)
    },
    copyBranch: (): void => {
      copyText(branchFor(item))
      host.flash(`Copied ${branchFor(item)}`)
    },
    openInBrowser: (): void => {
      if (item.url) window.open(item.url, '_blank')
      else host.flash(`No Jira link for ${item.key}`)
    }
  }
}

/** Writes a comment on the work item; Jira takes it as plain text */
function CommentBox({ itemKey, onPosted }: { itemKey: string; onPosted: () => void }): React.JSX.Element {
  const host = useHost()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const send = (): void => {
    if (!body.trim() || sending) return
    setSending(true)
    jiraApi
      .comment(itemKey, body.trim())
      .then(
        () => {
          setBody('')
          host.flash(`Commented on ${itemKey}`)
          onPosted()
        },
        (reason: unknown) => host.flash(errorMessage(reason))
      )
      .finally(() => setSending(false))
  }
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <textarea
        id={COMMENT_INPUT}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && send()}
        placeholder={`Comment on ${itemKey}`}
        rows={body ? 4 : 1}
        className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
      />
      {body && (
        <div className="mt-1 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-muted-foreground">Plain text</span>
          <button onClick={send} disabled={sending} className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
            {sending ? 'Sending...' : 'Comment'}
            <Kbd hint>⌘↵</Kbd>
          </button>
        </div>
      )}
    </div>
  )
}

/** The title, edited in place: Enter saves, Escape puts it back, and either returns focus to where e was pressed */
function EditableSummary({ summary, editing, onEditingChange, onSave }: { summary: string; editing: boolean; onEditingChange: (editing: boolean) => void; onSave: (summary: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(summary)
  const input = useRef<HTMLInputElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  // Enter or Escape ends the edit; the blur that follows must not end it again
  const finished = useRef(false)
  useEffect(() => {
    if (!editing) return
    finished.current = false
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft(summary)
    input.current?.focus()
    input.current?.select()
  }, [editing])
  const finish = (save: boolean): void => {
    if (finished.current) return
    finished.current = true
    if (save && draft.trim() && draft.trim() !== summary) onSave(draft.trim())
    onEditingChange(false)
    const back = returnTo.current
    requestAnimationFrame(() => back?.isConnected && back.focus({ preventScroll: true }))
  }
  if (!editing) {
    return (
      <h1 className="-mx-2">
        <button onClick={() => onEditingChange(true)} title="Edit summary (e)" className="w-full cursor-text rounded-md px-2 py-1 text-left text-[17px] leading-7 font-semibold break-words hover:bg-accent">
          {summary}
        </button>
      </h1>
    )
  }
  return (
    <div className="-mx-2 flex flex-col gap-1">
      <input
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') finish(true)
          if (event.key === 'Escape') {
            event.stopPropagation()
            finish(false)
          }
        }}
        className="h-9 w-full rounded-md bg-muted px-2 text-[17px] font-semibold ring-1 ring-border outline-none"
      />
      <span className="flex gap-3 px-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> save
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> cancel
        </span>
      </span>
    </div>
  )
}

/** Labels with a remove button each and a field to add one; the field keeps focus to add several */
function LabelEditor({ labels, onAdd, onRemove }: { labels: string[]; onAdd: (label: string) => void; onRemove: (label: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Labels</span>
      {labels.map((label) => (
        <span key={label} className="flex max-w-60 min-w-0 items-center gap-1 rounded bg-foreground/8 pr-0.5 pl-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{label}</span>
          <button title={`Remove ${label}`} onClick={() => onRemove(label)} className="grid size-4 shrink-0 place-items-center rounded hover:text-foreground">
            <Icon name="close" className="size-2.5" />
          </button>
        </span>
      ))}
      <label className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground focus-within:bg-muted hover:bg-accent">
        <Icon name="plus" className="size-3 shrink-0" />
        <input
          id={LABEL_INPUT}
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[\s,]/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft) {
              onAdd(draft)
              setDraft('')
            }
          }}
          placeholder="Add label"
          className="w-20 bg-transparent text-foreground outline-none placeholder:text-muted-foreground focus:w-32"
        />
        <Kbd hint>l</Kbd>
      </label>
    </div>
  )
}

/** A field of the item that a key changes, as a button with that key on it */
const Field = ({ label, combo, children }: { label: string; combo: string; children: React.ReactNode }): React.JSX.Element => (
  <span className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-border hover:bg-accent">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    {children}
    <Kbd hint>{combo}</Kbd>
  </span>
)

/** One detail under the title: a muted label and a value that truncates within the line */
const Meta = ({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element => (
  <span className="flex h-6 max-w-full min-w-0 items-center gap-1.5">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    {children}
  </span>
)

const SectionTitle =({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
)

export function TicketMain({
  ticket,
  epic,
  statuses,
  types,
  people,
  picker,
  setPicker,
  editingSummary,
  setEditingSummary
}: {
  ticket: Ticket | null
  epic: Epic | undefined
  statuses: StatusOption[]
  types: string[]
  people: JiraPerson[]
  picker: PickerId | null
  setPicker: (picker: PickerId | null) => void
  editingSummary: boolean
  setEditingSummary: (editing: boolean) => void
}): React.JSX.Element {
  const host = useHost()
  const [found, setFound] = useState<JiraPerson[]>([])
  useEffect(() => setFound([]), [ticket?.item.key])
  if (!ticket) return <EmptyState fill icon="list" title="Pick a ticket" />
  const { item, detail, error } = ticket
  const openChange = (id: PickerId) => (open: boolean) => setPicker(open ? id : null)
  const parent = detail?.parent ?? (epic ? { key: epic.key, summary: epic.summary, type: 'Epic' } : null)
  const order = Object.keys(CATEGORY_LABELS) as WorkItem['statusCategory'][]
  const everyone = [...new Map([...people, ...found].map((person) => [person.accountId, person])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const person = (name: string, avatar: string | null): React.ReactNode => (
    <>
      <UserAvatar name={name} url={avatar} size="size-5" />
      <span className="truncate">{name}</span>
    </>
  )

  return (
    <MarkdownFoldScope>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-1.5 text-xs text-muted-foreground">
        <ListToggle />
        <span className="shrink-0 font-mono text-foreground">{item.key}</span>
        <CopyButton label="Copy key" text={() => item.key} />
        <span className="flex-1" />
        <MarkdownFoldButton />
        {item.url && (
          <button onClick={ticket.openInBrowser} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent hover:text-foreground">
            <Icon name="external" className="size-3" />
            Jira
            <Kbd hint>o</Kbd>
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[860px] min-w-0 flex-col gap-3 px-6 py-4">
          <EditableSummary summary={item.summary} editing={editingSummary} onEditingChange={setEditingSummary} onSave={ticket.rename} />
          {ticket.failure && (
            <div className="flex items-start gap-2 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-400">
              <Icon name="alert" className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words select-text">{ticket.failure}</span>
              <button title="Dismiss" onClick={ticket.dismissFailure} className="grid size-4 shrink-0 place-items-center rounded hover:text-red-300">
                <Icon name="close" className="size-3" />
              </button>
            </div>
          )}
          {/* Status and assignee shrink first; the actions only drop to their own line once the fields hit their minimum */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex min-w-48 flex-1 basis-0 items-center gap-1.5">
              <Picker
                title="Change status (s)"
                trigger={
                  <Field label="Status" combo="s">
                    <StatusPill item={item} />
                  </Field>
                }
                options={[...statuses]
                  .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
                  .map((status) => ({ id: status.name, label: status.name, section: CATEGORY_LABELS[status.category], render: <StatusPill item={{ status: status.name, statusCategory: status.category }} /> }))}
                current={item.status}
                placeholder={`Move ${item.key} to...`}
                open={picker === 'status'}
                onOpenChange={openChange('status')}
                onPick={ticket.transition}
              />
              <Picker
                title="Assign (u)"
                trigger={
                  <Field label="Assignee" combo="u">
                    {item.assignee ? person(item.assignee, item.assigneeAvatar) : <span className="text-muted-foreground">Unassigned</span>}
                  </Field>
                }
                options={[
                  { id: MYSELF, label: 'Assign to me', section: '', render: <span className="font-medium">Assign to me</span> },
                  { id: UNASSIGN, label: 'Unassigned', section: '', render: <span className="text-muted-foreground">Unassigned</span> },
                  ...everyone.map((candidate) => ({ id: candidate.accountId, label: candidate.name, section: 'People', render: person(candidate.name, candidate.avatar) }))
                ]}
                current={item.assigneeId ?? (item.assignee ? null : UNASSIGN)}
                placeholder="Search people..."
                open={picker === 'assignee'}
                onOpenChange={openChange('assignee')}
                onQuery={(query) => jiraApi.assignable(item.key, query).then(setFound, () => setFound([]))}
                onPick={(id) => ticket.assign(id === UNASSIGN ? null : id)}
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Picker
                title={ticket.linked[0] ? `Worktrees for ${item.key}: w goes to ${ticket.linked[0].worktree.branch}, ⇧W creates another` : 'Create a worktree for this ticket (w)'}
                trigger={
                  <span className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-white hover:bg-primary/90">
                    <Icon name="branch" className="size-3.5" />
                    {ticket.linked[0] ? 'Go to worktree' : 'Open worktree'}
                    <Kbd hint>w</Kbd>
                  </span>
                }
                options={[
                  ...ticket.linked.map(({ repo, worktree }) => ({
                    id: `open:${worktree.path}`,
                    label: `${baseName(repo.path)} ${worktree.branch ?? ''}`,
                    section: 'Go to',
                    render: (
                      <>
                        <span className="shrink-0">{baseName(repo.path)}</span>
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{worktree.branch}</span>
                      </>
                    )
                  })),
                  ...ticket.repos.map((path) => ({ id: `new:${path}`, label: baseName(path), section: 'Create new in', render: <span className="truncate">{baseName(path)}</span> }))
                ]}
                current={null}
                placeholder="Worktree or repository..."
                width="w-72"
                align="right"
                open={picker === 'repo'}
                // With worktrees made already, the button lists them next to creating another
                onOpenChange={(open) => (!open ? setPicker(null) : ticket.linked.length > 0 ? setPicker('repo') : ticket.newWorktree())}
                onPick={(id) => (id.startsWith('open:') ? host.openWorktree(id.slice('open:'.length)) : ticket.createWorktree(id.slice('new:'.length)))}
              />
              <button onClick={ticket.addToComments} title="Add to agent comments (a)" className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-border hover:bg-accent">
                <Icon name="comment" className="size-3.5" />
                To agent
                <Kbd hint>a</Kbd>
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {item.priority && (
              <Meta label="Priority">
                <PriorityMark priority={item.priority} />
                <span className="truncate">{item.priority}</span>
              </Meta>
            )}
            <Meta label="Type">
              <Picker
                title="Change type (t)"
                trigger={
                  <span className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-accent">
                    <TypeMark type={item.type} />
                    <span className="truncate">{item.type}</span>
                    <Kbd hint>t</Kbd>
                  </span>
                }
                options={types.map((type) => ({ id: type, label: type, section: '', render: <><TypeMark type={type} /> {type}</> }))}
                current={item.type}
                placeholder="Change type..."
                width="w-48"
                open={picker === 'type'}
                onOpenChange={openChange('type')}
                onPick={ticket.retype}
              />
            </Meta>
            <Meta label="Project">
              <span className="truncate">{detail?.project ?? item.project}</span>
            </Meta>
            {parent && (
              <Meta label={/epic/i.test(parent.type) ? 'Epic' : 'Parent'}>
                {/epic/i.test(parent.type) ? (
                  <EpicChip summary={parent.summary} onClick={() => selection.update({ key: parent.key })} />
                ) : (
                  <button onClick={() => selection.update({ key: parent.key })} title={`Open ${parent.key}`} className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-accent">
                    <TypeMark type={parent.type} />
                    <span className="truncate">{parent.summary}</span>
                  </button>
                )}
              </Meta>
            )}
            {detail?.reporter && (
              <Meta label="Reporter">
                <UserAvatar name={detail.reporter} url={detail.reporterAvatar} size="size-4" />
                <span className="truncate">{detail.reporter}</span>
              </Meta>
            )}
            {detail?.updatedAt && (
              <Meta label="Updated">
                <span className="truncate">{timeAgo(detail.updatedAt)} ago</span>
              </Meta>
            )}
            <Meta label="Branch">
              <button onClick={ticket.copyBranch} title="Copy branch name (y)" className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-accent">
                <span className="truncate font-mono text-[11px]">{ticket.linked[0]?.worktree.branch ?? branchFor(item)}</span>
                <Kbd hint>y</Kbd>
              </button>
            </Meta>
            {ticket.linked.length > 0 && (
              <Meta label="Worktree">
                {ticket.linked.map(({ repo, worktree }) => (
                  <button key={worktree.path} onClick={() => host.openWorktree(worktree.path)} title={worktree.path} className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-accent">
                    <Icon name="branch" className="size-3.5 shrink-0 text-emerald-400" />
                    <span className="truncate">{baseName(repo.path)}</span>
                    {worktree.changedFiles > 0 && <span className="shrink-0 text-[11px] text-muted-foreground">{worktree.changedFiles} changed</span>}
                  </button>
                ))}
              </Meta>
            )}
          </div>
          <section className="flex flex-col gap-1">
            <SectionTitle>Description</SectionTitle>
            {error && <p className="text-xs break-words text-red-400 select-text">{error}</p>}
            {!detail && !error && <p className="text-xs text-muted-foreground">Loading...</p>}
            {detail && (detail.description ? <Markdown resolveImage={resolveImage}>{detail.description}</Markdown> : <p className="text-xs text-muted-foreground">No description</p>)}
          </section>
          {detail && <LabelEditor labels={ticket.labels} onAdd={ticket.addLabel} onRemove={ticket.removeLabel} />}
          {detail && <LinkPreviews urls={detail.links} exclude={[item.key]} />}
          {detail && (
            <section className="flex flex-col gap-2">
              <SectionTitle>Comments {detail.comments.length || ''}</SectionTitle>
              {detail.comments.map((comment, index) => (
                <div key={`${comment.created}:${index}`} className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs">
                    <UserAvatar name={comment.author} url={comment.authorAvatar} size="size-5" />
                    <span className="truncate font-medium">{comment.author}</span>
                    <span className="shrink-0 text-muted-foreground">{timeAgo(comment.created)} ago</span>
                  </div>
                  <Markdown resolveImage={resolveImage}>{comment.body}</Markdown>
                </div>
              ))}
              <CommentBox key={item.key} itemKey={item.key} onPosted={ticket.reload} />
            </section>
          )}
        </div>
      </div>
    </MarkdownFoldScope>
  )
}
