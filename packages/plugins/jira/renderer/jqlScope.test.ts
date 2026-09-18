import { expect, test } from 'bun:test'
import { scopedJql, withoutAssignee } from './api'

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
