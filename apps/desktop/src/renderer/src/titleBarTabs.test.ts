import { expect, test } from 'bun:test'
import { arrangeBar, moveItem, parseBarLayout, SEARCH_ITEM, SPACE_ITEMS } from './titleBarTabs'

const [left, right] = SPACE_ITEMS
const tabs = ['terminal', 'browser', 'prs', 'worktrees']

test('an empty layout puts the tabs before the search between its spaces', () => {
  expect(arrangeBar(tabs, [])).toEqual([...tabs, left, SEARCH_ITEM, right])
})

test('tabs the layout does not name go before the first space, gone ones drop out', () => {
  expect(arrangeBar(tabs, ['prs', left, 'browser', SEARCH_ITEM, 'gone', right])).toEqual(['prs', 'terminal', 'worktrees', left, 'browser', SEARCH_ITEM, right])
})

test('an item moves before another or to the end', () => {
  const order = ['terminal', 'hub', left, SEARCH_ITEM, right]
  expect(moveItem(order, 'hub', SEARCH_ITEM)).toEqual(['terminal', left, 'hub', SEARCH_ITEM, right])
  expect(moveItem(order, SEARCH_ITEM, 'terminal')).toEqual([SEARCH_ITEM, 'terminal', 'hub', left, right])
  expect(moveItem(order, 'terminal', null)).toEqual(['hub', left, SEARCH_ITEM, right, 'terminal'])
})

test('the older left and right sides read as a row', () => {
  expect(parseBarLayout({ left: ['a', 1], right: ['b'] })).toEqual(['a', left, SEARCH_ITEM, right, 'b'])
  expect(parseBarLayout({ left: [], right: [] })).toEqual([])
  expect(parseBarLayout('x')).toEqual([])
  expect(parseBarLayout(['a', 2, SEARCH_ITEM])).toEqual(['a', SEARCH_ITEM])
})

test('buttons an older layout lacks keep their place: the arrows lead, the rest trail', () => {
  expect(arrangeBar(tabs, ['prs', left, SEARCH_ITEM, right, 'browser'], ['bar:nav'], ['bar:settings'])).toEqual([
    'bar:nav',
    'prs',
    'terminal',
    'worktrees',
    left,
    SEARCH_ITEM,
    right,
    'browser',
    'bar:settings'
  ])
  // Dragged ones stay where they were dropped
  expect(arrangeBar(tabs, ['bar:settings', left, SEARCH_ITEM, right], ['bar:nav'], ['bar:settings'])).toEqual(['bar:nav', 'bar:settings', ...tabs, left, SEARCH_ITEM, right])
})
