import { expect, test } from 'bun:test'
import { admit, entering, watchItems, type WatchItem } from './watch'

const item = (key: string): WatchItem => ({ source: 'jira', key, title: key, url: null, labels: [] })

test('only items that start matching start runs, and never one already being worked on', () => {
  expect(entering(null, [item('A'), item('B')], new Set(['B'])).map((entry) => entry.key)).toEqual(['A'])
  expect(entering(new Set(['A']), [item('A'), item('C')], new Set()).map((entry) => entry.key)).toEqual(['C'])
  // Unmarked and marked again: gone from the last check, so it runs again
  expect(entering(new Set(['C']), [item('A'), item('C')], new Set()).map((entry) => entry.key)).toEqual(['A'])
})

test('only as many tickets start as there is room for; the rest stay unseen and start on a later check', () => {
  const first = admit(null, [item('A'), item('B'), item('C')], new Set(), 2)
  expect(first.start.map((entry) => entry.key)).toEqual(['A', 'B'])
  expect(first.seen).toEqual(['A', 'B'])
  // Both still running: C waits
  const full = admit(new Set(first.seen), [item('A'), item('B'), item('C')], new Set(['A', 'B']), 0)
  expect(full.start).toEqual([])
  expect(full.seen).toEqual(['A', 'B'])
  // A finished: C takes its place
  const freed = admit(new Set(full.seen), [item('A'), item('B'), item('C')], new Set(['B']), 1)
  expect(freed.start.map((entry) => entry.key)).toEqual(['C'])
  expect(freed.seen).toEqual(['A', 'B', 'C'])
})

test('Jira answers keys, summaries and labels, Notion page ids and titles', () => {
  expect(watchItems('jira', JSON.stringify([{ key: 'AB-1', summary: 'Fix', url: 'https://j/AB-1', labels: ['web'] }, { summary: 'no key' }]))).toEqual([
    { source: 'jira', key: 'AB-1', title: 'Fix', url: 'https://j/AB-1', labels: ['web'] }
  ])
  expect(watchItems('notion', JSON.stringify([{ id: 'p1', title: 'Task', url: '' }]))).toEqual([{ source: 'notion', key: 'p1', title: 'Task', url: null, labels: [] }])
})
