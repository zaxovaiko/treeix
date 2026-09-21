import { expect, test } from 'bun:test'
import { commandExists, isSafeCommandName, newerVersion, signedInAccounts } from './tools'

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

test('isSafeCommandName accepts plain command words and absolute paths', () => {
  expect(isSafeCommandName('npx')).toBe(true)
  expect(isSafeCommandName('claude-agent-acp')).toBe(true)
  expect(isSafeCommandName('gemini_cli.v2')).toBe(true)
  expect(isSafeCommandName('/usr/local/bin/npx')).toBe(true)
})

test('isSafeCommandName rejects anything that could break out of the argument', () => {
  expect(isSafeCommandName('x$(rm -rf ~)')).toBe(false)
  expect(isSafeCommandName('`rm -rf ~`')).toBe(false)
  expect(isSafeCommandName('npx; rm -rf ~')).toBe(false)
  expect(isSafeCommandName('npx && rm -rf ~')).toBe(false)
  expect(isSafeCommandName('npx -y pkg')).toBe(false)
  expect(isSafeCommandName('')).toBe(false)
})

test('commandExists rejects an unsafe name without running a shell', async () => {
  expect(await commandExists('x$(rm -rf ~)')).toBe(false)
})

test('commandExists finds a binary that is really on PATH', async () => {
  expect(await commandExists('ls')).toBe(true)
})

test('commandExists is false for a plausible but nonexistent binary', async () => {
  expect(await commandExists('treeix-definitely-not-a-real-binary')).toBe(false)
})
