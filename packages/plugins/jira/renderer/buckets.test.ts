import { expect, test } from 'bun:test'
import type { WorkItem } from '../shared/types'
import { bucketOf, byPriority } from './buckets'

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
