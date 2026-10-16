import { expect, test } from 'bun:test'
import { entering, watchItems, type WatchItem } from './watch'

const item = (key: string): WatchItem => ({ source: 'jira', key, title: key, url: null })

test('only items that start matching start runs, and never one already being worked on', () => {
  expect(entering(null, [item('A'), item('B')], new Set(['B'])).map((entry) => entry.key)).toEqual(['A'])
  expect(entering(new Set(['A']), [item('A'), item('C')], new Set()).map((entry) => entry.key)).toEqual(['C'])
  // Unmarked and marked again: gone from the last check, so it runs again
  expect(entering(new Set(['C']), [item('A'), item('C')], new Set()).map((entry) => entry.key)).toEqual(['A'])
})

test('Jira answers keys and summaries, Notion page ids and titles', () => {
  expect(watchItems('jira', JSON.stringify([{ key: 'AB-1', summary: 'Fix', url: 'https://j/AB-1' }, { summary: 'no key' }]))).toEqual([
    { source: 'jira', key: 'AB-1', title: 'Fix', url: 'https://j/AB-1' }
  ])
  expect(watchItems('notion', JSON.stringify([{ id: 'p1', title: 'Task', url: '' }]))).toEqual([{ source: 'notion', key: 'p1', title: 'Task', url: null }])
})
