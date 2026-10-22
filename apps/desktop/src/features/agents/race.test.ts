import { expect, test } from 'bun:test'
import { raceTargets } from './race'

test('raceTargets: one worktree per racing agent', () => {
  expect(raceTargets('feat/race', ['claude', 'codex'])).toEqual([
    { branch: 'feat/race-claude', agent: 'claude' },
    { branch: 'feat/race-codex', agent: 'codex' },
  ])
  expect(raceTargets('feat/race', ['codex'])).toEqual([{ branch: 'feat/race', agent: 'codex' }])
  expect(raceTargets('feat/race', [])).toEqual([{ branch: 'feat/race', agent: null }])
})
