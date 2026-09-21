import { expect, test } from 'bun:test'
import { type BrowserState, closeTab, openTab, patchTab, reopenTab, selectTab } from './tabs'

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
