import { expect, test } from 'bun:test'
import { orderedJql, scopedJql, textClause, withoutAssignee } from './api'

test('scopedJql folds the filters Jira can apply into the query, keeping ORDER BY last', () => {
  const base = 'statusCategory != Done ORDER BY updated DESC'
  expect(scopedJql(base, { mine: true, projects: [] })).toBe('assignee = currentUser() AND (statusCategory != Done) ORDER BY updated DESC')
  expect(scopedJql(base, { mine: false, projects: [] })).toBe('(statusCategory != Done) ORDER BY updated DESC')
  expect(scopedJql(base, { mine: false, projects: ['BF', 'MC'] })).toBe('project in (BF, MC) AND (statusCategory != Done) ORDER BY updated DESC')
  expect(scopedJql('ORDER BY updated DESC', { mine: true, projects: ['BF'] })).toBe('assignee = currentUser() AND project in (BF) ORDER BY updated DESC')
})

test('withoutAssignee drops the clause older settings stored', () => {
  expect(withoutAssignee('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')).toBe('statusCategory != Done ORDER BY updated DESC')
  expect(withoutAssignee('project = BF')).toBe('project = BF')
})

test('scopedJql turns typed text into a Jira search over everything, keys included', () => {
  const base = 'statusCategory != Done ORDER BY updated DESC'
  expect(scopedJql(base, { mine: false, projects: ['BF'], texts: ['sessio'] })).toBe('project in (BF) AND text ~ "sessio*" ORDER BY updated DESC')
  expect(scopedJql(base, { mine: false, projects: [], texts: ['bf-12'] })).toBe('(key = BF-12 OR text ~ "bf 12") ORDER BY updated DESC')
})

test('textClause keeps quotes and Lucene operators out of the query', () => {
  expect(textClause('say "hi" (now)')).toBe('text ~ "say hi now*"')
  expect(textClause('***')).toBeNull()
})

test('orderedJql swaps the saved ORDER BY for the chosen sort', () => {
  expect(orderedJql('statusCategory != Done ORDER BY updated DESC', 'created')).toBe('statusCategory != Done ORDER BY created DESC')
  expect(orderedJql('project = BF', 'updated')).toBe('project = BF ORDER BY updated DESC')
  expect(orderedJql('project = BF ORDER BY rank', null)).toBe('project = BF ORDER BY rank')
})
