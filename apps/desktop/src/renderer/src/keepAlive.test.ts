import { expect, test } from 'bun:test'
import { keptPages, visitedIn } from './keepAlive'

const tabs = [{ id: 'terminal' }, { id: 'browser' }, { id: 'prs' }]

test('keeps the pages already visited, in tab order, plus the active one', () => {
  expect(keptPages(tabs, ['browser'], 'prs').map((tab) => tab.id)).toEqual(['browser', 'prs'])
})

test('a page visited twice is kept once', () => {
  expect(keptPages(tabs, ['browser', 'browser'], 'browser').map((tab) => tab.id)).toEqual(['browser'])
})

test('drops a page whose plugin is gone', () => {
  expect(keptPages(tabs, ['jira'], 'terminal').map((tab) => tab.id)).toEqual(['terminal'])
})

test('a tab that is not a plugin page keeps nothing extra', () => {
  expect(keptPages(tabs, ['browser'], 'worktrees').map((tab) => tab.id)).toEqual(['browser'])
})

test('a page shown in a split or the overlay is not kept hidden as well', () => {
  expect(keptPages(tabs, ['browser', 'prs'], 'terminal', ['browser', 'prs']).map((tab) => tab.id)).toEqual(['terminal'])
})

test('visitedIn forgets the pages of another workspace right away', () => {
  expect(visitedIn({ workspace: 'a', tabs: ['prs'] }, 'a')).toEqual(['prs'])
  expect(visitedIn({ workspace: 'a', tabs: ['prs'] }, 'b')).toEqual([])
})
