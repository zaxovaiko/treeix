import { expect, test } from 'bun:test'
import { newerVersion, signedInAccounts } from './tools'

test('signedInAccounts reads gh and glab auth output', () => {
  expect(signedInAccounts('github.com\n  ✓ Logged in to github.com account zaxovaiko (keyring)')).toEqual(['zaxovaiko @ github.com'])
  expect(signedInAccounts('gitlab.blurify.com\n  ✓ Logged in to gitlab.blurify.com as vlad (/Users/x/config.yml)')).toEqual([
    'vlad @ gitlab.blurify.com'
  ])
  expect(signedInAccounts('You are not logged into any GitHub hosts')).toEqual([])
})

test('newerVersion compares the installed version line with a release tag', () => {
  expect(newerVersion('gh version 2.100.0 (2026-09-03)', 'v2.101.0')).toBe('2.101.0')
  expect(newerVersion('2.1.274 (Claude Code)', '2.1.274')).toBeNull()
  expect(newerVersion('codex-cli 0.150.1', '0.99.9')).toBeNull()
  expect(newerVersion('glab 1.117.0 (44790937b)', '')).toBeNull()
})
