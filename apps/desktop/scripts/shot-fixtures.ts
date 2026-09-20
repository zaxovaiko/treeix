/**
 * Made-up Jira and Confluence answers for the marketing screenshots.
 *
 * Both plugins read through `persistentCache`, so an entry stored with a fresh `fetchedAt` is used as is and
 * nothing is ever asked of acli or the Atlassian API. That keeps the shots free of a real site and a real token.
 */

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString()

/** A cache entry as `persistentCache` stores it: `cache.<name>` holds [id, { value, fetchedAt }] pairs */
const cache = (name: string, entries: [string, unknown][]): [string, unknown] => [
  `cache.${name}`,
  entries.map(([id, value]) => [id, { value, fetchedAt: Date.now() }])
]

/** The query JiraTasks builds from its defaults: the saved JQL, narrowed to your own items */
const JQL = 'assignee = currentUser() AND (statusCategory != Done) ORDER BY updated DESC'
const ME = 'Ada Park'

type Item = {
  key: string
  summary: string
  status: string
  statusCategory: 'new' | 'indeterminate' | 'done'
  type: string
  priority: string
  updatedAt: string
}

const ITEMS: Item[] = [
  { key: 'ORB-142', summary: 'Show usage invoices in billing settings', status: 'In Progress', statusCategory: 'indeterminate', type: 'Story', priority: 'High', updatedAt: hoursAgo(1) },
  { key: 'ORB-147', summary: 'Sessions expire after an hour of work', status: 'In Progress', statusCategory: 'indeterminate', type: 'Bug', priority: 'Highest', updatedAt: hoursAgo(3) },
  { key: 'ORB-139', summary: 'Rate limit the public metrics endpoint', status: 'Code Review', statusCategory: 'indeterminate', type: 'Task', priority: 'Medium', updatedAt: hoursAgo(6) },
  { key: 'ORB-151', summary: 'Invoice PDF misses the tax line for EU accounts', status: 'QA Blocked', statusCategory: 'indeterminate', type: 'Bug', priority: 'High', updatedAt: hoursAgo(22) },
  { key: 'ORB-155', summary: 'Let an account change its billing email', status: 'To Do', statusCategory: 'new', type: 'Story', priority: 'Medium', updatedAt: hoursAgo(27) },
  { key: 'ORB-158', summary: 'Retry failed Stripe webhooks with a backoff', status: 'To Do', statusCategory: 'new', type: 'Task', priority: 'Low', updatedAt: hoursAgo(30) },
  { key: 'ORB-160', summary: 'Design the plan comparison table', status: 'Backlog', statusCategory: 'new', type: 'Story', priority: 'Low', updatedAt: hoursAgo(50) }
]

const workItem = (item: Item): Record<string, unknown> => ({
  ...item,
  assignee: ME,
  // No avatar URL, so the row draws initials instead of fetching a picture over the network
  assigneeAvatar: null,
  assigneeId: 'acc-ada',
  project: 'Orbit',
  url: `https://orbit-labs.atlassian.net/browse/${item.key}`
})

const DETAIL = {
  ...workItem(ITEMS[0]),
  description: [
    'Accounts on a paid plan can open the Stripe portal, but they cannot see what they were charged without leaving Orbit.',
    '',
    '**Scope**',
    '',
    '- List the last 12 invoices under Billing, newest first',
    '- Show the total in the account currency and the paid date',
    '- An unpaid invoice links straight to its Stripe hosted page',
    '',
    'Totals come back from Stripe in cents, so the conversion needs a test of its own.'
  ].join('\n'),
  reporter: 'Noor Haddad',
  reporterAvatar: null,
  labels: ['billing', 'self-service'],
  parent: { key: 'ORB-100', summary: 'Billing self-service', type: 'Epic' },
  comments: [
    { author: 'Noor Haddad', authorAvatar: null, created: hoursAgo(20), body: 'Design is in Figma, the table matches the plan card above it.' },
    { author: ME, authorAvatar: null, created: hoursAgo(2), body: 'listInvoices is in the worktree with a test. Paging past 100 invoices is the one open question.' }
  ],
  links: []
}

const EPICS = [
  {
    key: 'ORB-100',
    summary: 'Billing self-service',
    status: 'In Progress',
    statusCategory: 'indeterminate' as const,
    children: [
      { key: 'ORB-142', done: false },
      { key: 'ORB-151', done: false },
      { key: 'ORB-155', done: false },
      { key: 'ORB-160', done: false },
      { key: 'ORB-131', done: true },
      { key: 'ORB-128', done: true }
    ]
  }
]

/** Tasks tab: the list, the signed-in name, the open item's detail, and the epic its rows are chipped with */
export function jiraState(): Record<string, unknown> {
  return Object.fromEntries([
    cache('jira.me', [['me', ME]]),
    cache('jira.list', [[JQL, { items: ITEMS.map(workItem), sprintKeys: ['ORB-142', 'ORB-147', 'ORB-139', 'ORB-151', 'ORB-155'], error: null }]]),
    cache('jira.detail', [['ORB-142', DETAIL]]),
    cache('jira.epics', [['ORB', EPICS]]),
    ['jira.selected@all', 'ORB-142'],
    ['jira.collapsed@all', JSON.stringify(['done'])]
  ])
}

const PAGE_ID = '88014'
const SPEC = {
  id: PAGE_ID,
  title: 'Billing self-service',
  space: 'Orbit product',
  url: 'https://orbit-labs.atlassian.net/wiki/spaces/ORB/pages/88014/Billing+self-service',
  body: [
    'Paying customers should never have to email us to answer "what did I pay for last month". This page is the shape we agreed on for the billing area.',
    '',
    '## What a customer can do',
    '',
    '| Action | Where | Notes |',
    '| --- | --- | --- |',
    '| See the current plan | Billing header | Name and renewal date |',
    '| Read the last 12 invoices | Billing table | Total, paid date, PDF |',
    '| Change the billing email | Billing header | Separate from the login email |',
    '| Open the Stripe portal | Button | For cards and cancellation |',
    '',
    '## Invoices',
    '',
    'Stripe is the source of truth. Orbit never stores a total, it reads the list per request and caches it for a minute.',
    '',
    '- Totals arrive in cents and are shown in the account currency',
    '- An invoice with no `paid_at` counts as unpaid and links to its hosted page',
    '- Past 100 invoices the list has to page, which the first version does not do yet',
    '',
    '## Open questions',
    '',
    '1. Do we show refunds as their own row, or fold them into the invoice they belong to?',
    '2. Which currency do we show for an account that changed plans mid-year?'
  ].join('\n'),
  parentId: null,
  children: [
    { id: '88020', title: 'Invoice table states' },
    { id: '88031', title: 'Dunning emails' }
  ],
  updatedAt: hoursAgo(5),
  links: []
}

const RECENT = [
  { id: PAGE_ID, title: 'Billing self-service', space: 'Orbit product', lastModified: hoursAgo(5) },
  { id: '88020', title: 'Invoice table states', space: 'Orbit product', lastModified: hoursAgo(26) },
  { id: '88031', title: 'Dunning emails', space: 'Orbit product', lastModified: hoursAgo(48) },
  { id: '77410', title: 'Session lifetime and clock skew', space: 'Orbit engineering', lastModified: hoursAgo(9) },
  { id: '77455', title: 'Rate limiting the public API', space: 'Orbit engineering', lastModified: hoursAgo(72) },
  { id: '61002', title: 'Release checklist', space: 'Orbit engineering', lastModified: hoursAgo(120) }
]

/** Confluence tab: the recent list, the page it opens on, and that page in the Opened here list */
export function confluenceState(): Record<string, unknown> {
  return Object.fromEntries([
    cache('confluence.recent', [['recent', { pages: RECENT, error: null }]]),
    cache('confluence.page', [[PAGE_ID, SPEC]]),
    ['confluence.selected@all', PAGE_ID],
    ['confluence.opened@all', JSON.stringify([{ id: PAGE_ID, title: SPEC.title, space: SPEC.space, lastModified: SPEC.updatedAt }])]
  ])
}
