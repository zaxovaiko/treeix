import { expect, test } from 'bun:test'
import type { Ticket } from '../../ipc/api'
import { isBranchFor, ticketBranch, ticketPrompt, ticketRows } from './branch'

const ticket = (key: string, title: string, kind: Ticket['kind'] = 'task'): Ticket => ({ key, source: 'jira', kind, title, status: 'To Do', url: null, project: null, updatedAt: null })

test('ticketBranch: prefix by kind, key, four words without stopwords', () => {
  expect(ticketBranch(ticket('TRX-47', 'The ports popover loses focus after a kill', 'bug'))).toBe('fix/trx-47-ports-popover-loses-focus')
  expect(ticketBranch(ticket('TRX-52', 'Show GitLab pipeline status in the PR list', 'story'))).toBe('feat/trx-52-show-gitlab-pipeline-status')
  expect(ticketBranch(ticket('1a2b3c4d5e6f', 'Ship it!'))).toBe('feat/1a2b3c4d5e6f-ship-it')
  expect(ticketBranch(ticket('TRX-1', '---'))).toBe('feat/trx-1')
})

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

test('ticketRows hides tickets with a branch and filters by key or title', () => {
  const all = [ticket('TRX-47', 'Ports popover'), ticket('TRX-52', 'Pipeline status'), ticket('TRX-58', 'Usage pill')]
  expect(ticketRows(all, ['main', 'origin/fix/trx-47-ports'], '').map((t) => t.key)).toEqual(['TRX-52', 'TRX-58'])
  expect(ticketRows(all, [], 'pill').map((t) => t.key)).toEqual(['TRX-58'])
  expect(ticketRows(all, [], 'trx-52').map((t) => t.key)).toEqual(['TRX-52'])
})

test('ticketPrompt quotes the title, link and description', () => {
  expect(ticketPrompt({ ticket: { ...ticket('TRX-58', 'Usage pill'), url: 'https://x/TRX-58' }, description: 'Show it.\n' })).toBe('TRX-58: Usage pill\n\nhttps://x/TRX-58\n\nShow it.')
})
