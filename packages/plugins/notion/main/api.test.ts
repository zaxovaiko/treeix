import { expect, test } from 'bun:test'
import { failure } from './api'

test('a rejected token turns into the fix', () => {
  expect(failure(401, { object: 'error', code: 'unauthorized', message: 'API token is invalid.' })).toStartWith('Notion rejected the token')
})

test("other failures keep Notion's message", () => {
  expect(failure(404, { object: 'error', code: 'object_not_found', message: 'Could not find data source.' })).toBe('Could not find data source.')
  expect(failure(502, null)).toBe('Notion answered 502')
})
