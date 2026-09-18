import { expect, test } from 'bun:test'
import { planTitle, readPlan } from './plans'

test('planTitle uses the first top-level heading', () => {
  expect(planTitle('intro\n## Context\n# quick-diff: viewer \n', 'fallback')).toBe('quick-diff: viewer')
  expect(planTitle('no heading', 'fallback')).toBe('fallback')
})

test('readPlan refuses paths outside the plans folder', async () => {
  expect(await readPlan('../settings.json')).toBeNull()
  expect(await readPlan('../../.ssh/id_rsa.md')).toBeNull()
})
