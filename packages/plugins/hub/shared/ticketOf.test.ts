import { expect, test } from 'bun:test'
import { ticketOf } from './workflow'

test('ticketOf reads a schedule title first, then the ticket a watch started the run for', () => {
  expect(ticketOf({ title: 'jira:BF-7 BF-7 Fix it', ticket: null })).toEqual({ source: 'jira', key: 'BF-7' })
  expect(ticketOf({ title: 'notion:0f3a Meal timing', ticket: null })).toEqual({ source: 'notion', key: '0f3a' })
  expect(ticketOf({ title: 'Ship: BF-9 Login', ticket: { key: 'BF-9', url: 'https://x/BF-9' } })).toEqual({ source: 'jira', key: 'BF-9' })
  expect(ticketOf({ title: 'Ship: Meal timing', ticket: { key: '0f3a9b', url: 'https://notion.so/0f3a9b' } })).toEqual({ source: 'notion', key: '0f3a9b' })
  expect(ticketOf({ title: 'Ask scout', ticket: null })).toBeNull()
})
