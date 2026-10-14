import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { shellQuote } from './shell'

test('shellQuote round-trips through zsh and bash', () => {
  const prompt = 'Review comments:\n1. it\'s `broken` \\ $HOME "quoted"'
  for (const shell of ['/bin/zsh', '/bin/bash'].filter(existsSync)) {
    expect(execFileSync(shell, ['-c', `printf %s ${shellQuote(prompt)}`]).toString()).toBe(prompt)
  }
})
