import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateUserData } from './userData'

test('migrateUserData moves legacy data into an empty target once', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-'))
  const legacy = join(root, 'quick-diff')
  const target = join(root, 'Treeix')
  mkdirSync(legacy)
  mkdirSync(target)
  writeFileSync(join(legacy, 'Preferences'), 'old')
  writeFileSync(join(target, '.DS_Store'), '')

  expect(migrateUserData(legacy, target)).toBe(target)
  expect(readFileSync(join(target, 'Preferences'), 'utf8')).toBe('old')
  expect(existsSync(legacy)).toBe(false)

  mkdirSync(legacy)
  writeFileSync(join(legacy, 'Preferences'), 'stale')
  expect(migrateUserData(legacy, target)).toBe(target)
  expect(readFileSync(join(target, 'Preferences'), 'utf8')).toBe('old')
})
