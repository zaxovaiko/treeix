import { expect, test } from 'bun:test'
import { resolvePath } from './open'

test('printed paths resolve against the session cwd', () => {
  expect(resolvePath('/r/app', 'src/a.ts')).toBe('/r/app/src/a.ts')
  expect(resolvePath('/r/app', './src/../b.ts')).toBe('/r/app/b.ts')
  expect(resolvePath('/r/app', '../lib/c.ts')).toBe('/r/lib/c.ts')
  expect(resolvePath('/r/app', '/etc/hosts')).toBe('/etc/hosts')
})
