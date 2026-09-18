import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { shellQuote } from './shell'

test('shellQuote round-trips through zsh', () => {
  const prompt = "Review comments:\n1. it's `broken` \\ $HOME \"quoted\""
  expect(execFileSync('/bin/zsh', ['-c', `printf %s ${shellQuote(prompt)}`]).toString()).toBe(prompt)
})
