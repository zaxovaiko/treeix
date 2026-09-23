import { expect, test } from 'bun:test'
import { devCommand } from './devServer'

test('devCommand runs the first dev-like script with the lockfile package manager', () => {
  expect(devCommand({ scripts: { start: 'x', dev: 'y' } }, ['pnpm-lock.yaml'])).toBe('pnpm run dev')
  expect(devCommand({ scripts: { serve: 'x' } }, [])).toBe('npm run serve')
  expect(devCommand({ scripts: { build: 'x' } }, ['bun.lock'])).toBeNull()
  expect(devCommand(null, [])).toBeNull()
})
