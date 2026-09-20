import { expect, test } from 'bun:test'
import { isBranchFor } from './branch'

test('isBranchFor matches the key only where it ends', () => {
  expect(isBranchFor('OPN-41-rate-limit', 'OPN-41')).toBe(true)
  expect(isBranchFor('OPN-41', 'OPN-41')).toBe(true)
  expect(isBranchFor('feature/opn-41_fix', 'OPN-41')).toBe(true)
  expect(isBranchFor('OPN-41-rate-limit-2', 'OPN-41')).toBe(true)
  expect(isBranchFor('OPN-412-rate-limit', 'OPN-41')).toBe(false)
  expect(isBranchFor('XOPN-41-fix', 'OPN-41')).toBe(false)
  expect(isBranchFor('main', 'OPN-41')).toBe(false)
  expect(isBranchFor(null, 'OPN-41')).toBe(false)
})
