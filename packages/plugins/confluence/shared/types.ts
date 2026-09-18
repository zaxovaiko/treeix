export type PageSummary = {
  id: string
  title: string
  space: string | null
  /** ISO date, null when unknown */
  lastModified: string | null
}

export type Space = { id: string; key: string; name: string }

export type Page = {
  id: string
  title: string
  /** Space the page lives in, null when the space list couldn't be read */
  space: string | null
  url: string
  /** Markdown; attachment images point at IMAGE_HOST sources the renderer loads through the plugin */
  body: string
  parentId: string | null
  children: { id: string; title: string }[]
  updatedAt: string | null
  /** Every URL in the page, for link previews */
  links: string[]
}

export type PageList = { pages: PageSummary[]; error: string | null }
