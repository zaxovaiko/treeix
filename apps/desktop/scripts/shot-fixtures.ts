/**
 * Made-up Jira and Confluence answers for the marketing screenshots.
 *
 * Both plugins read through `persistentCache`, so an entry stored with a fresh `fetchedAt` is used as is and
 * nothing is ever asked of acli or the Atlassian API. That keeps the shots free of a real site and a real token.
 */

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString()

/** A cache entry as `persistentCache` stores it: `cache.<name>` holds [id, { value, fetchedAt }] pairs */
const cache = (name: string, entries: [string, unknown][]): [string, unknown] => [`cache.${name}`, entries.map(([id, value]) => [id, { value, fetchedAt: Date.now() }])]

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
  {
    key: 'ORB-142',
    summary: 'Show usage invoices in billing settings',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    type: 'Story',
    priority: 'High',
    updatedAt: hoursAgo(1)
  },
  {
    key: 'ORB-147',
    summary: 'Sessions expire after an hour of work',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    type: 'Bug',
    priority: 'Highest',
    updatedAt: hoursAgo(3)
  },
  {
    key: 'ORB-139',
    summary: 'Rate limit the public metrics endpoint',
    status: 'Code Review',
    statusCategory: 'indeterminate',
    type: 'Task',
    priority: 'Medium',
    updatedAt: hoursAgo(6)
  },
  {
    key: 'ORB-151',
    summary: 'Invoice PDF misses the tax line for EU accounts',
    status: 'QA Blocked',
    statusCategory: 'indeterminate',
    type: 'Bug',
    priority: 'High',
    updatedAt: hoursAgo(22)
  },
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

/**
 * Usage limits the title bar reads: LimitBar's Claude cache and a Codex rollout, both under the demo home,
 * so no real account's numbers show up.
 */
export async function writeLimitFixtures(home: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const window = (usedPercent: number, hours: number) => ({ usedPercent, resetsAt: now + Math.round(hours * 3600) })
  await Bun.write(
    `${home}/Library/Application Support/LimitBar/claude/latest.json`,
    JSON.stringify({ capturedAt: now - 60, fiveHour: window(42, 2.3), weekly: window(61, 3 * 24 + 7) })
  )
  const codexWindow = (minutes: number, used: number, hours: number) => ({ window_minutes: minutes, used_percent: used, resets_at: now + Math.round(hours * 3600) })
  const day = new Date().toISOString().slice(0, 10).split('-').join('/')
  const event = {
    timestamp: new Date((now - 120) * 1000).toISOString(),
    payload: { rate_limits: { primary: codexWindow(300, 18, 3.8), secondary: codexWindow(10_080, 34, 5 * 24 + 2) } }
  }
  await Bun.write(`${home}/.codex/sessions/${day}/rollout-demo.jsonl`, `${JSON.stringify(event)}\n`)
}

const ENV_EXAMPLE = `# @secret
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
DATABASE_URL=
SESSION_SECRET=
NEXT_PUBLIC_STRIPE_KEY=
NEXT_PUBLIC_APP_URL=
BILLING_RETURN_URL=
`
const PACKAGE_JSON = JSON.stringify({ name: 'orbit-web', private: true, dependencies: { next: '15.5.0', stripe: '18.4.0' } }, null, 2)

/** Env tab: main has every variable, the invoices worktree lacks the webhook secret, drifts on one URL and leaks a key to the browser */
export async function writeEnvFixtures(main: string, worktree: string): Promise<void> {
  const env = (extra: Record<string, string>): string =>
    `${Object.entries({
      STRIPE_SECRET_KEY: 'sk_test_51Demo0rbitK3yNotReal000',
      STRIPE_WEBHOOK_SECRET: 'whsec_demo_orbit_local',
      DATABASE_URL: 'postgres://orbit:orbit-dev@localhost:5432/orbit',
      SESSION_SECRET: 'd3m0-s3ss10n-s3cr3t',
      NEXT_PUBLIC_STRIPE_KEY: 'pk_test_51Demo0rbitPublic000',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      BILLING_RETURN_URL: 'https://orbit.dev/account',
      ...extra
    })
      .filter(([, value]) => value !== '')
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`
  for (const root of [main, worktree]) {
    await Bun.write(`${root}/.env.example`, ENV_EXAMPLE)
    await Bun.write(`${root}/package.json`, PACKAGE_JSON)
  }
  await Bun.write(`${main}/.env.local`, env({}))
  await Bun.write(
    `${worktree}/.env.local`,
    env({ STRIPE_WEBHOOK_SECRET: '', BILLING_RETURN_URL: 'https://orbit.dev/billing', NEXT_PUBLIC_STRIPE_SECRET: 'sk_test_51Demo0rbitK3yNotReal000' })
  )
}

/** The page the Browser tab shows, served on localhost like the worktree's dev server would be */
export const ORBIT_BILLING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Billing · Orbit</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;background:#f7f7f8;color:#18181b}
header{display:flex;align-items:center;gap:28px;padding:16px 40px;background:#fff;border-bottom:1px solid #e4e4e7}
.logo{font-weight:700;font-size:17px;display:flex;align-items:center;gap:8px}.logo i{width:18px;height:18px;border-radius:50%;background:conic-gradient(#6366f1,#22d3ee,#6366f1);display:block}
nav{display:flex;gap:20px;color:#71717a}nav b{color:#18181b;font-weight:600}
main{max-width:920px;margin:36px auto;padding:0 32px}h1{font-size:26px;margin:0 0 4px}.sub{color:#71717a;margin:0 0 28px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:22px 24px;margin-bottom:20px}
.plan{display:flex;justify-content:space-between;align-items:center}.plan h2{margin:0;font-size:18px}.plan p{margin:2px 0 0;color:#71717a}
button{font:inherit;border:1px solid #d4d4d8;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer}button.primary{background:#18181b;color:#fff;border-color:#18181b}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:500;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:0 0 10px}
td{padding:12px 0;border-top:1px solid #f0f0f2}.tag{font-size:12px;border-radius:99px;padding:2px 10px}.paid{background:#dcfce7;color:#166534}.open{background:#fef3c7;color:#92400e}
td.num{font-variant-numeric:tabular-nums}a{color:#4f46e5;text-decoration:none}
</style></head><body>
<header><div class="logo"><i></i>Orbit</div><nav><span>Dashboard</span><span>Projects</span><span>Team</span><b>Billing</b></nav></header>
<main><h1>Billing</h1><p class="sub">Plan, invoices and payment details for Orbit Labs</p>
<div class="card plan"><div><h2>Team plan</h2><p>$49 / month · renews on Oct 14</p></div><div style="display:flex;gap:8px"><button>Change email</button><button class="primary">Open Stripe portal</button></div></div>
<div class="card"><table><thead><tr><th>Invoice</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
<tr><td>INV-0112</td><td>Sep 14, 2026</td><td class="num">$49.00</td><td><span class="tag open">Unpaid</span></td><td><a href="#">Pay now</a></td></tr>
<tr><td>INV-0104</td><td>Aug 14, 2026</td><td class="num">$49.00</td><td><span class="tag paid">Paid</span></td><td><a href="#">PDF</a></td></tr>
<tr><td>INV-0097</td><td>Jul 14, 2026</td><td class="num">$49.00</td><td><span class="tag paid">Paid</span></td><td><a href="#">PDF</a></td></tr>
<tr><td>INV-0089</td><td>Jun 14, 2026</td><td class="num">$29.00</td><td><span class="tag paid">Paid</span></td><td><a href="#">PDF</a></td></tr>
<tr><td>INV-0081</td><td>May 14, 2026</td><td class="num">$29.00</td><td><span class="tag paid">Paid</span></td><td><a href="#">PDF</a></td></tr>
</tbody></table></div></main></body></html>`

/** Ignored, so the Env tab still reads them but the worktree diff and changed-file counts stay as they were */
export async function ignoreEnvFixtures(main: string): Promise<void> {
  const exclude = `${main}/.git/info/exclude`
  const current = await Bun.file(exclude)
    .text()
    .catch(() => '')
  if (!current.includes('.env*')) await Bun.write(exclude, `${current}.env*\npackage.json\n`)
}

const user = (login: string) => ({ login, avatar_url: null })

/**
 * Fake `gh` and `glab` on the demo PATH: orbit-web gets a GitHub remote, orbit-api a GitLab one, and every call the
 * Pull requests plugin makes is answered from canned data. Logins with a dot are not real GitHub accounts, so no one's
 * avatar or name shows up.
 */
export async function writePullRequestFixtures(home: string, web: string, api: string, worktree: string): Promise<void> {
  Bun.spawnSync(['git', '-C', web, 'remote', 'add', 'origin', 'git@github.com:orbit-labs/orbit-web.git'])
  Bun.spawnSync(['git', '-C', api, 'remote', 'add', 'origin', 'git@gitlab.com:orbit-labs/orbit-api.git'])
  const tracked = Bun.spawnSync(['git', '-C', worktree, 'diff', '--no-color', 'main']).stdout.toString()
  const added = Bun.spawnSync(['git', '-C', worktree, 'diff', '--no-color', '--no-index', '/dev/null', 'src/billing/invoices.test.ts']).stdout.toString()
  const pr = (number: number, title: string, author: string, head: string, hours: number, extra: Record<string, unknown> = {}) => ({
    number,
    title,
    author: { login: author },
    headRefName: head,
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: false,
    updatedAt: hoursAgo(hours),
    additions: 38,
    deletions: 1,
    changedFiles: 2,
    url: `https://github.com/orbit-labs/orbit-web/pull/${number}`,
    mergeable: 'MERGEABLE',
    ...extra
  })
  const github = {
    list: [
      pr(482, 'Show usage invoices in billing settings', 'ada.park', 'feat/usage-invoices', 2),
      pr(479, 'Keep sessions alive for twelve hours', 'ada.park', 'fix/session-timeout', 5, { isDraft: true, additions: 4, deletions: 2, changedFiles: 1 }),
      pr(471, 'Drop the legacy plan nicknames', 'noor.haddad', 'chore/plan-nicknames', 9, { additions: 12, deletions: 96, changedFiles: 6 }),
      pr(466, 'Invoice PDF shows the EU tax line', 'lena.ko', 'fix/eu-tax-line', 30, { state: 'MERGED', additions: 21, deletions: 3 })
    ],
    reviews: {
      data: {
        viewer: { login: 'ada.park' },
        search: {
          nodes: [
            {
              number: 482,
              author: { login: 'ada.park' },
              reviewRequests: { nodes: [] },
              latestReviews: { nodes: [] },
              commits: { nodes: [] },
              head: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
              comments: { totalCount: 1 },
              reviewThreads: { totalCount: 2 }
            },
            {
              number: 479,
              author: { login: 'ada.park' },
              reviewRequests: { nodes: [] },
              latestReviews: { nodes: [] },
              commits: { nodes: [] },
              head: { nodes: [] },
              comments: { totalCount: 0 },
              reviewThreads: { totalCount: 0 }
            },
            {
              number: 471,
              author: { login: 'noor.haddad' },
              reviewRequests: { nodes: [{ requestedReviewer: { login: 'ada.park' } }] },
              latestReviews: { nodes: [] },
              commits: { nodes: [] },
              head: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
              comments: { totalCount: 2 },
              reviewThreads: { totalCount: 0 }
            }
          ]
        }
      }
    },
    view: {
      headRefOid: 'f12ab29c4e1d',
      body: [
        'Adds the invoice list behind the billing portal link, so an account can see what it was charged without writing to support.',
        '',
        '- `listInvoices` pulls the last twelve invoices and converts cents to units',
        '- unpaid invoices keep a null paid date, the table shows them as pending',
        '- covered by `src/billing/invoices.test.ts`',
        '',
        'Closes ORB-142.'
      ].join('\n')
    },
    diff: tracked + added,
    reviewComments: [
      {
        id: 101,
        user: user('noor.haddad'),
        path: 'src/billing/portal.ts',
        line: 25,
        side: 'RIGHT',
        created_at: hoursAgo(5),
        reactions: { '+1': 2, eyes: 1 },
        body: 'Stripe caps `invoices.list` at 100 per page. A busy account would silently lose the older ones - use auto-pagination here.'
      },
      {
        id: 102,
        in_reply_to_id: 101,
        user: user('ada.park'),
        path: 'src/billing/portal.ts',
        line: 25,
        side: 'RIGHT',
        created_at: hoursAgo(2),
        reactions: {},
        body: 'Twelve is the product cap for now, but agreed it should not depend on the page size. Switching to `autoPagingToArray` and slicing after.'
      },
      {
        id: 103,
        user: user('lena.ko'),
        path: 'src/billing/invoices.test.ts',
        line: 12,
        side: 'RIGHT',
        created_at: hoursAgo(9),
        reactions: {},
        body: 'Worth one more case for a refunded invoice - the total comes back negative there.'
      }
    ],
    issueComments: [
      {
        id: 201,
        user: user('noor.haddad'),
        created_at: hoursAgo(9),
        reactions: { rocket: 1 },
        body: 'Design signed off on the table in the Confluence page. Ship it behind the existing billing flag.'
      }
    ],
    extra: {
      data: {
        viewer: { login: 'ada.park' },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 'PRRT_1', isResolved: false, comments: { nodes: [{ databaseId: 101 }] } },
                { id: 'PRRT_2', isResolved: false, comments: { nodes: [{ databaseId: 103 }] } }
              ]
            },
            files: { nodes: [] },
            author: { login: 'ada.park' },
            reviewRequests: { nodes: [{ requestedReviewer: { login: 'noor.haddad', avatarUrl: null } }] },
            latestReviews: { nodes: [{ author: { login: 'lena.ko', avatarUrl: null }, state: 'COMMENTED' }] },
            viewerLatestReview: null,
            assignees: { nodes: [{ login: 'ada.park', avatarUrl: null }] }
          }
        }
      }
    }
  }
  const mr = (iid: number, title: string, author: string, branch: string, hours: number, notes: number, state = 'opened') => ({
    iid,
    title,
    author: { username: author, avatar_url: null },
    source_branch: branch,
    target_branch: 'main',
    state,
    draft: false,
    updated_at: hoursAgo(hours),
    web_url: `https://gitlab.com/orbit-labs/orbit-api/-/merge_requests/${iid}`,
    user_notes_count: notes,
    has_conflicts: false
  })
  const gitlab = {
    list: [
      mr(212, 'Sliding window rate limiter for the public API', 'lena.ko', 'feat/sliding-window', 3, 4),
      mr(208, 'Retry Stripe webhooks with a backoff', 'ada.park', 'feat/webhook-retry', 26, 2, 'merged')
    ],
    pipelines: { data: { project: { mergeRequests: { nodes: [{ iid: '212', headPipeline: { status: 'RUNNING', path: '/orbit-labs/orbit-api/-/pipelines/9912' } }] } } } }
  }
  const script = (answers: unknown, routes: string): string => `#!${process.execPath}
// Stands in for the real CLI in screenshots: canned answers, no network, no account
const args = process.argv.slice(2)
const line = args.join(' ')
const F = ${JSON.stringify(answers)}
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
${routes}
`
  const gh = script(
    github,
    `if (args[0] === '--version') out('gh version 2.81.0 (2026-09-10)\\n')
else if (args[0] === 'auth') out('')
else if (line.startsWith('pr list')) out(F.list)
else if (line.startsWith('pr view')) out(F.view)
else if (line.startsWith('pr diff')) out(F.diff)
else if (line.includes('graphql') && line.includes('is:pr')) out(F.reviews)
else if (line.includes('graphql')) out(F.extra)
else if (/pulls\\/\\d+\\/comments/.test(line)) out([F.reviewComments])
else if (/issues\\/\\d+\\/comments/.test(line)) out([F.issueComments])
else { process.stderr.write('not in the demo: gh ' + line + '\\n'); process.exit(1) }`
  )
  const glab = script(
    gitlab,
    `if (args[0] === '--version') out('glab 1.72.0 (2026-09-02)\\n')
else if (args[0] === 'auth') out('')
else if (line.includes('graphql')) out(F.pipelines)
else if (line.includes('merge_requests?')) out(F.list)
else { process.stderr.write('not in the demo: glab ' + line + '\\n'); process.exit(1) }`
  )
  await Bun.write(`${home}/bin/gh`, gh)
  await Bun.write(`${home}/bin/glab`, glab)
  Bun.spawnSync(['chmod', '+x', `${home}/bin/gh`, `${home}/bin/glab`])
}
