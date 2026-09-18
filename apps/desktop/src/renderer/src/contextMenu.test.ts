import { expect, test } from 'bun:test'
import { normalizeEntries } from './contextMenu'

test('normalizeEntries hides skipped items and stray separators', () => {
  const action = (label: string): { label: string; run: () => void } => ({ label, run: () => undefined })
  const labels = (entries: ReturnType<typeof normalizeEntries>): (string | null)[] => entries.map((entry) => entry?.label ?? null)
  expect(labels(normalizeEntries([null, action('a'), null, null, false, action('b'), null, undefined]))).toEqual(['a', null, 'b'])
  expect(labels(normalizeEntries([action('a'), null, false]))).toEqual(['a'])
})
