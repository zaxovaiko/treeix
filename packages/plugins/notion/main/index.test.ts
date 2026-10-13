import { expect, test } from 'bun:test'
import { failure } from './index'

test('a missing or signed-out ntn turns into the fix', () => {
  expect(failure(Object.assign(new Error('spawn ntn ENOENT'), { code: 'ENOENT' }))).toStartWith('Notion CLI not found')
  expect(failure({ stderr: 'Error: No workspace selected.\n  hint: Run `ntn login` first, or set NOTION_WORKSPACE_ID.\n' })).toBe(
    'Notion CLI is not signed in: run ntn login in a terminal'
  )
})

test("other failures keep ntn's first line without its prefix", () => {
  expect(failure({ stderr: 'error: Public API request failed (404 Not Found object_not_found): Could not find data source.\n' })).toBe(
    'Public API request failed (404 Not Found object_not_found): Could not find data source.'
  )
})
