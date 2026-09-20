import { expect, test } from 'bun:test'
import { cqlString, searchCql, toPageSummaries } from './search'

test('toPageSummaries reads CQL search results', () => {
  const raw = { results: [{ content: { id: '42', title: 'Wallet' }, resultGlobalContainer: { title: 'Betfeel' }, lastModified: '2026-07-03T15:41:42.000Z' }, { title: 'user result' }] }
  expect(toPageSummaries(raw)).toEqual([{ id: '42', title: 'Wallet', space: 'Betfeel', lastModified: '2026-07-03T15:41:42.000Z' }])
})

test('cqlString escapes quotes and backslashes', () => {
  expect(cqlString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"')
})

test('searchCql needs every text and any of the spaces', () => {
  expect(searchCql(['wallet'], [])).toBe('type = page AND siteSearch ~ "wallet"')
  expect(searchCql(['wallet', 'say "hi"'], ['BF', 'OPS'])).toBe('type = page AND siteSearch ~ "wallet" AND siteSearch ~ "say \\"hi\\"" AND space in ("BF", "OPS")')
})
