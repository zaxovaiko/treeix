import { expect, test } from 'bun:test'
import { failure, parseSite } from '@treeix/atlassian/main/cli'
import { sprintJql, threadComments, toWorkItem } from './acli'

test('toWorkItem reads Jira issue JSON and builds the browse link', () => {
  const item = toWorkItem(
    {
      key: 'OPN-412',
      self: 'https://team.atlassian.net/rest/api/3/issue/10001',
      fields: {
        summary: 'Rate limit behind proxy',
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        assignee: null,
        assigneeAvatar: null,
        project: { name: 'Openora' },
        updated: '2026-09-17T10:00:00.000+0000'
      }
    },
    'team.atlassian.net'
  )
  expect(item).toEqual({
    key: 'OPN-412',
    summary: 'Rate limit behind proxy',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    type: 'Bug',
    priority: 'High',
    assignee: null,
    assigneeAvatar: null,
    assigneeId: null,
    project: 'Openora',
    updatedAt: '2026-09-17T10:00:00.000+0000',
    url: 'https://team.atlassian.net/browse/OPN-412'
  })
})

test('toWorkItem falls back to the key prefix for the project and reads the site from auth status', () => {
  expect(toWorkItem({ key: 'BF-324', fields: { summary: 'x' } }, null)).toMatchObject({ project: 'BF', url: null, statusCategory: 'new' })
  expect(parseSite('✓ Authenticated\n  Site: studiosoftware.atlassian.net\n  Authentication Type: oauth_global')).toBe('studiosoftware.atlassian.net')
})

test('sprintJql keeps ORDER BY at the end', () => {
  expect(sprintJql('assignee = currentUser() ORDER BY updated DESC')).toBe('(assignee = currentUser()) AND sprint in openSprints() ORDER BY updated DESC')
  expect(sprintJql('project = BF')).toBe('(project = BF) AND sprint in openSprints()')
})

test("threadComments nests a comment opening with an earlier author under that author's thread", () => {
  const comment = (id: string, author: string, body: string) => ({ id, author, authorAvatar: null, authorId: null, created: '', body, replies: [] })
  const roots = threadComments([
    comment('1', 'Ann Lee', 'Why EKS?'),
    comment('2', 'Bo Kim', '@Ann Lee cost'),
    comment('3', 'Ann Lee', '@Bo Kim ok'),
    comment('4', 'Cy Park', '@Dan Nobody hi'),
    comment('5', 'Cy Park', 'CC @Ann Lee')
  ])
  expect(roots.map((root) => root.id)).toEqual(['1', '4', '5'])
  expect(roots[0].replies?.map((reply) => reply.id)).toEqual(['2', '3'])
})

test('the sign-in hint names a command that runs', () => {
  expect(failure({ stderr: "✗ Error: unauthorized: use 'acli [product] auth login' to authenticate\n" })).toBe(
    'Unauthorized: use acli jira auth login --web in a terminal to authenticate'
  )
})
