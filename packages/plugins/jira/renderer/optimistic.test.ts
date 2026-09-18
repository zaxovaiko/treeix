import { expect, test } from 'bun:test'
import type { WorkItem } from '../shared/types'
import { applyPatch, PATCH_TTL_MS, pendingPatches } from './optimistic'

const item = (key: string, status: string): WorkItem => ({
  key, summary: '', status, statusCategory: 'new', type: 'Task', priority: null, assignee: null, assigneeAvatar: null, project: 'BF', updatedAt: '', url: null
})

test('applyPatch shows the change before Jira confirms it', () => {
  expect(applyPatch(item('BF-1', 'To Do'), { 'BF-1': { fields: { status: 'Done' }, at: 0 } }).status).toBe('Done')
  expect(applyPatch(item('BF-2', 'To Do'), { 'BF-1': { fields: { status: 'Done' }, at: 0 } }).status).toBe('To Do')
})

test('pendingPatches keeps a patch until the list agrees or it gets too old', () => {
  const patches = { 'BF-1': { fields: { status: 'Done' }, at: 1000 } }
  expect(Object.keys(pendingPatches([item('BF-1', 'To Do')], patches, 2000))).toEqual(['BF-1'])
  expect(Object.keys(pendingPatches([item('BF-1', 'Done')], patches, 2000))).toEqual([])
  expect(Object.keys(pendingPatches([item('BF-1', 'To Do')], patches, 1000 + PATCH_TTL_MS + 1))).toEqual([])
})
