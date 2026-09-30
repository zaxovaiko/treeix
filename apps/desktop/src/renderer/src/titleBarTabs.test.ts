import { expect, test } from 'bun:test'
import { arrangeTabs, moveTab, parseTabLayout } from './titleBarTabs'

const tabs = ['terminal', 'browser', 'prs', 'worktrees'].map((id) => ({ id }))
const ids = (side: { id: string }[]): string[] => side.map((tab) => tab.id)

test('tabs the layout does not name stay left in their default order', () => {
  const arranged = arrangeTabs(tabs, { left: ['prs'], right: ['browser', 'gone'] })
  expect(ids(arranged.left)).toEqual(['prs', 'terminal', 'worktrees'])
  expect(ids(arranged.right)).toEqual(['browser'])
})

test('a tab moves before another or to the end of either side', () => {
  const layout = { left: ['terminal', 'browser', 'prs'], right: ['worktrees'] }
  expect(moveTab(layout, 'prs', 'left', 'terminal')).toEqual({ left: ['prs', 'terminal', 'browser'], right: ['worktrees'] })
  expect(moveTab(layout, 'terminal', 'right', null)).toEqual({ left: ['browser', 'prs'], right: ['worktrees', 'terminal'] })
  expect(moveTab(layout, 'worktrees', 'left', 'browser')).toEqual({ left: ['terminal', 'worktrees', 'browser', 'prs'], right: [] })
})

test('a malformed stored layout reads as empty', () => {
  expect(parseTabLayout('x')).toEqual({ left: [], right: [] })
  expect(parseTabLayout({ left: ['a', 1], right: null })).toEqual({ left: ['a'], right: [] })
})
