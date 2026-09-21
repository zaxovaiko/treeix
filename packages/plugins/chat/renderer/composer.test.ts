import { expect, test } from 'bun:test'
import { completion, formatTokens, imageProblem, switchWarning } from './composer'

test('imageProblem', () => {
  expect(imageProblem({ type: 'image/png', size: 1000 })).toBeNull()
  expect(imageProblem({ type: 'image/png', size: 6 * 1024 * 1024 })).toBe('Images up to 5 MB')
  expect(imageProblem({ type: 'application/pdf', size: 10 })).toBe('PNG, JPEG, GIF or WebP only')
})

test('slash completion only at the start, file completion after @ anywhere', () => {
  const commands = [{ name: 'compact', description: 'Summarize' }, { name: 'clear', description: 'Start over' }]
  expect(completion('/co', 3, commands, [])).toMatchObject({ kind: 'command', query: 'co', start: 0, items: [{ label: '/compact', insert: '/compact ' }] })
  expect(completion('fix /co', 7, commands, [])).toBeNull()
  expect(completion('see @src/pri', 12, [], ['src/pricing/Pricing.tsx', 'src/app.ts'])).toMatchObject({ kind: 'file', query: 'src/pri', start: 4, items: [{ label: 'src/pricing/Pricing.tsx', insert: '@src/pricing/Pricing.tsx ' }] })
  expect(completion('mail me@home', 12, [], ['home.ts'])).toBeNull()
})

test('switchWarning and formatTokens', () => {
  expect(switchWarning({ used: 9000 })).toBeNull()
  expect(switchWarning({ used: 48000 })).toEqual({ tokens: 48000 })
  expect(switchWarning(null)).toEqual({ tokens: null })
  expect(formatTokens(48123)).toBe('48k')
  expect(formatTokens(1234567)).toBe('1.2M')
})
