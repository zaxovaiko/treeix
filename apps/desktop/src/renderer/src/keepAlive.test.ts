import { expect, test } from 'bun:test'
import { keptPages, keyboardPage, visitedIn } from './keepAlive'

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

test('bare keys belong to the tab on screen', () => {
  expect(keyboardPage('prs', null, false)).toBe('prs')
})

test('bare keys belong to the split pane while it has the keyboard', () => {
  expect(keyboardPage('prs', 'terminal', true)).toBe('terminal')
})

test('a split pane without the keyboard leaves the keys to the tab on screen', () => {
  expect(keyboardPage('prs', 'terminal', false)).toBe('prs')
})

test('a page shown in the split is not kept hidden as well', () => {
  expect(keptPages(tabs, ['browser', 'prs'], 'terminal', 'browser').map((tab) => tab.id)).toEqual(['terminal', 'prs'])
})

test('visitedIn forgets the pages of another workspace right away', () => {
  expect(visitedIn({ workspace: 'a', tabs: ['prs'] }, 'a')).toEqual(['prs'])
  expect(visitedIn({ workspace: 'a', tabs: ['prs'] }, 'b')).toEqual([])
})
