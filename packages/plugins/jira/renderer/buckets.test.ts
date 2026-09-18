import { expect, test } from 'bun:test'
import type { WorkItem } from '../shared/types'
import { bucketOf, byPriority, groupByEpic, sortItems } from './buckets'

const item = (status: string, statusCategory: WorkItem['statusCategory'], priority: string | null = 'Normal', key = 'BF-1'): WorkItem => ({
  key, summary: '', status, statusCategory, type: 'Story', priority, assignee: null, assigneeAvatar: null, project: 'BF', updatedAt: '', url: null
})

test('bucketOf sorts statuses by whose move it is', () => {
  expect(bucketOf(item('In Progress', 'indeterminate'), true, {})).toBe('mine')
  expect(bucketOf(item('QA Blocked', 'new'), true, {})).toBe('mine')
  expect(bucketOf(item('Blocked', 'new'), true, {})).toBe('blocked')
  expect(bucketOf(item('To Test', 'new'), true, {})).toBe('waiting')
  expect(bucketOf(item('Code Review', 'indeterminate'), true, {})).toBe('waiting')
  expect(bucketOf(item('To Merge', 'indeterminate'), false, {})).toBe('waiting')
  expect(bucketOf(item('To Do', 'new'), true, {})).toBe('next')
  expect(bucketOf(item('To Do', 'new'), false, {})).toBe('later')
  expect(bucketOf(item('To Do', 'new'), null, {})).toBe('next')
  expect(bucketOf(item('Backlog', 'new'), true, {})).toBe('later')
  expect(bucketOf(item('To Test', 'new'), true, { 'To Test': 'mine' })).toBe('mine')
})

test('byPriority puts urgent first and keeps order otherwise', () => {
  const keys = byPriority([item('x', 'new', 'Normal', 'A-1'), item('x', 'new', 'Major', 'A-2'), item('x', 'new', 'Normal', 'A-3'), item('x', 'new', 'Low', 'A-4')]).map((entry) => entry.key)
  expect(keys).toEqual(['A-2', 'A-1', 'A-3', 'A-4'])
})

test('groupByEpic puts items under their epic, busiest epic first, loose items last', () => {
  const epic = (key: string, children: string[]) => ({ key, summary: key, status: 'Open', statusCategory: 'new' as const, children: children.map((child) => ({ key: child, done: false })) })
  const items = ['BF-1', 'BF-2', 'BF-3', 'BF-4', 'BF-10'].map((key) => item('To Do', 'new', 'Normal', key))
  const groups = groupByEpic(items, [epic('BF-10', ['BF-1']), epic('BF-20', ['BF-2', 'BF-3'])])
  expect(groups.map((group) => [group.epic?.key ?? null, group.items.map((entry) => entry.key)])).toEqual([
    ['BF-20', ['BF-2', 'BF-3']],
    ['BF-10', ['BF-1']],
    [null, ['BF-4']]
  ])
})

test('sortItems by status puts work in progress first, then priority', () => {
  const keys = sortItems([item('To Do', 'new', 'Highest', 'A-1'), item('QA Blocked', 'indeterminate', 'Major', 'A-2'), item('In Progress', 'indeterminate', 'Normal', 'A-3'), item('In Progress', 'indeterminate', 'Major', 'A-4')], 'status').map((entry) => entry.key)
  expect(keys).toEqual(['A-4', 'A-3', 'A-2', 'A-1'])
})
