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
  project: string
  /** Empty in search results, which can't include it */
  updatedAt: string
  /** Browser link, null when the CLI didn't say which site it came from */
  url: string | null
}

export type WorkItemComment = { author: string; authorAvatar: string | null; created: string; body: string }

export type WorkItemDetail = WorkItem & {
  /** Markdown; attachment images point at IMAGE_HOST sources the renderer loads through the plugin */
  description: string
  reporter: string | null
  reporterAvatar: string | null
  labels: string[]
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
