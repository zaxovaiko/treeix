import { lazy, Suspense, useEffect, useState } from 'react'
import { ApiToken } from '@treeix/atlassian/renderer/ApiToken'
import { type Command, type HostApi, type RendererPlugin, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { Row } from '@treeix/app/settingsUi'
import { UserAvatar } from '@treeix/app/ui'
import type { WorkItem } from '../shared/types'
import { useCached } from '@treeix/atlassian/renderer/cache'
import { DEFAULT_JQL, jiraApi, jiraBridge, jiraSettings, listCache, selection, summaryCache, TTL } from './api'
import { StatusPill, TypeMark } from './marks'

// Views load when the Tasks tab first opens
const JiraTasks = lazy(() => import('./JiraTasks').then((module) => ({ default: module.JiraTasks })))

const TAB_ID = 'tasks'

function TasksTab(): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <JiraTasks />
    </Suspense>
  )
}

const issueKeyOf = (url: string): string | null => url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/)?.[1] ?? null

/** A linked Jira issue with its status; clicking shows it in the Tasks tab */
function IssuePreview({ url }: { url: string }): React.JSX.Element {
  const host = useHost()
  const key = issueKeyOf(url) ?? ''
  const { value: item, error } = useCached<WorkItem>(summaryCache, key, TTL.summary, jiraApi.summary)
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
      <button
        onClick={() => {
          selection.update({ key })
          host.setActiveTab(TAB_ID)
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
      >
        {item ? <TypeMark type={item.type} /> : <Icon name="list" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-mono text-muted-foreground">{key}</span>
        <span className="truncate">{item?.summary ?? error ?? 'Loading...'}</span>
      </button>
      {item?.assignee && <UserAvatar name={item.assignee} url={item.assigneeAvatar} size="size-5" />}
      {item && <StatusPill item={item} />}
      <a href={url} target="_blank" rel="noreferrer" title="Open in Jira" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <Icon name="external" className="size-3" />
      </a>
    </div>
  )
}

function JiraSettings(): React.JSX.Element {
  const { jql } = jiraSettings.use()
  const [draft, setDraft] = useState(jql)
  useEffect(() => setDraft(jql), [jql])
  return (
    <>
      <Row label="Work items" description="JQL for the Tasks tab, without the assignee: the tab's Mine and Anyone switch adds that. Needs the Atlassian CLI signed in: acli jira auth login --web">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => jiraSettings.update({ jql: draft.trim() || DEFAULT_JQL })}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          className="h-8 w-80 shrink-0 rounded-lg bg-muted px-2.5 font-mono text-[11.5px] ring-1 ring-border outline-none"
        />
      </Row>
      <ApiToken bridge={jiraBridge} purpose="Screenshots and attachments" />
    </>
  )
}

const TICKET_KEYS: [keys: string, label: string][] = [
  ['s', 'Change status'],
  ['u', 'Assign'],
  ['e', 'Edit summary'],
  ['l', 'Add label'],
  ['c', 'Comment'],
  ['t', 'Change type'],
  ['w', 'Open worktree, or go to it'],
  ['a', 'Add to agent comments'],
  ['o y', 'Open in Jira / copy branch name'],
  ['/', 'Search Jira'],
  ['f', 'Only mine, or everyone'],
  ['v', 'Group by whose move or epic'],
  ['⇧S', 'Sort'],
  ['← →', 'Fold / unfold the group'],
  ['z', 'Fold or unfold all groups']
]

/** Work items already fetched by the list or a preview, so ! in the palette finds them without a request */
function ticketCommands(host: HostApi): Command[] {
  const items = [...listCache.values().flatMap((list) => list.items), ...summaryCache.values()]
  const unique = [...new Map(items.map((item) => [item.key, item])).values()]
  return unique.map((item) => ({
    id: `ticket:${item.key}`,
    group: 'Tasks',
    label: `${item.key} ${item.summary}`,
    detail: item.status,
    icon: 'ticket',
    run: () => {
      selection.update({ key: item.key })
      host.setActiveTab(TAB_ID)
    }
  }))
}

const plugin: RendererPlugin = {
  commands: ticketCommands,
  shortcuts: TICKET_KEYS.map(([keys, label]) => ({ keys, label, section: 'Tasks', page: TAB_ID })),
  tabs: [{ id: TAB_ID, label: 'Tasks', icon: 'kanban', order: 40, render: TasksTab, panels: ['terminal'] }],
  Settings: JiraSettings,
  linkPreviews: [{ label: 'Jira', keyOf: issueKeyOf, render: IssuePreview }]
}

export default plugin
