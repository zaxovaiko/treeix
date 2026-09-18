import { expect, test } from 'bun:test'
import { parseSite } from '@treeix/atlassian/main/cli'
import { sprintJql, toWorkItem } from './acli'

test('toWorkItem reads Jira issue JSON and builds the browse link', () => {
  const item = toWorkItem({
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
  }, 'team.atlassian.net')
  expect(item).toEqual({
    key: 'OPN-412',
    summary: 'Rate limit behind proxy',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    type: 'Bug',
    priority: 'High',
    assignee: null,
    assigneeAvatar: null,
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
