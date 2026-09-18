export type WorkItem = {
  key: string
  summary: string
  status: string
  /** Jira's status category: new, indeterminate or done */
  statusCategory: 'new' | 'indeterminate' | 'done'
  type: string
  priority: string | null
  assignee: string | null
  assigneeAvatar: string | null
  /** Account id, which assigning needs; absent in lists cached before it was added */
  assigneeId?: string | null
  project: string
  /** Empty in search results, which can't include it */
  updatedAt: string
  /** Browser link, null when the CLI didn't say which site it came from */
  url: string | null
}

/** An open epic and the keys of every item under it, so the list can group by epic and show progress */
export type Epic = {
  key: string
  summary: string
  status: string
  statusCategory: WorkItem['statusCategory']
  children: { key: string; done: boolean }[]
}

/** Someone an item can be assigned to */
export type JiraPerson = { accountId: string; name: string; avatar: string | null }

/** What the detail pane can change through acli; description isn't here because acli would flatten its formatting */
export type WorkItemEdit = { summary?: string; type?: string; addLabels?: string[]; removeLabels?: string[] }

export type WorkItemComment = { author: string; authorAvatar: string | null; created: string; body: string }

export type WorkItemDetail = WorkItem & {
  /** Markdown; attachment images point at IMAGE_HOST sources the renderer loads through the plugin */
  description: string
  reporter: string | null
  reporterAvatar: string | null
  labels: string[]
  /** The epic or parent item this one belongs to */
  parent: { key: string; summary: string; type: string } | null
  comments: WorkItemComment[]
  /** Every URL in the description and comments, for link previews */
  links: string[]
}

export type WorkItemList = {
  items: WorkItem[]
  /** Keys of the items in an open sprint; null when the sprint lookup failed, e.g. no boards */
  sprintKeys: string[] | null
  error: string | null
}
