import { expect, test } from 'bun:test'
import { type BrowserState, closeTab, groupTab, moveTab, openTab, patchTab, renameGroup, reopenTab, selectTab } from './tabs'

const empty: BrowserState = { tabs: [], activeId: null, closed: [] }

test('openTab adds after the active tab and shows it', () => {
  const one = openTab(empty, 'https://a.test', 'a')
  const two = openTab(one, 'https://b.test', 'b')
  const three = openTab(selectTab(two, 'a'), 'https://c.test', 'c')
  expect(three.tabs.map((tab) => tab.id)).toEqual(['a', 'c', 'b'])
  expect(three.activeId).toBe('c')
})

test('closeTab shows the next tab, else the previous, and remembers the URL', () => {
  let state = openTab(openTab(openTab(empty, 'https://a.test', 'a'), 'https://b.test', 'b'), 'https://c.test', 'c')
  state = closeTab(selectTab(state, 'b'), 'b')
  expect(state.activeId).toBe('c')
  state = closeTab(state, 'c')
  expect(state.activeId).toBe('a')
  expect(state.closed).toEqual(['https://c.test', 'https://b.test'])
})

test('reopenTab brings back the last closed URL', () => {
  const state = reopenTab(closeTab(openTab(empty, 'https://a.test', 'a'), 'a'))
  expect(state.tabs.map((tab) => tab.url)).toEqual(['https://a.test'])
  expect(state.closed).toEqual([])
  expect(reopenTab(empty)).toBe(empty)
})

test('patchTab changes one tab only', () => {
  const state = patchTab(openTab(openTab(empty, 'https://a.test', 'a'), 'https://b.test', 'b'), 'a', { title: 'A' })
  expect(state.tabs.map((tab) => tab.title)).toEqual(['A', ''])
})

const ids = (state: BrowserState): string[] => state.tabs.map((tab) => tab.id)
const abc = openTab(openTab(openTab(empty, 'https://a.test', 'a'), 'https://b.test', 'b'), 'https://c.test', 'c')

test('moveTab puts a tab at the target and takes its group', () => {
  expect(ids(moveTab(abc, 'c', 'a'))).toEqual(['c', 'a', 'b'])
  expect(ids(moveTab(abc, 'a', 'c'))).toEqual(['b', 'c', 'a'])
  const grouped = groupTab(abc, 'b', 'work')
  expect(moveTab(grouped, 'a', 'b').tabs.find((tab) => tab.id === 'a')?.group).toBe('work')
})

test('groupTab keeps a group together and ungrouping sends the tab to the end', () => {
  let state = groupTab(abc, 'a', 'work')
  state = groupTab(state, 'c', 'work')
  expect(ids(state)).toEqual(['a', 'c', 'b'])
  expect(ids(openTab(selectTab(state, 'a'), 'https://d.test', 'd'))).toEqual(['a', 'd', 'c', 'b'])
  expect(ids(groupTab(state, 'a', undefined))).toEqual(['c', 'b', 'a'])
  expect(renameGroup(state, 'work', 'api').tabs.map((tab) => tab.group)).toEqual(['api', 'api', undefined])
})
