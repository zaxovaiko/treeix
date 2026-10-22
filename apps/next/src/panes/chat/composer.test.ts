import { expect, test } from 'bun:test'
import { browsedFolder, completion, folderPath, formatTokens, imageProblem, parseShellPrompt, switchWarning } from './composer'

test('imageProblem', () => {
  expect(imageProblem({ type: 'image/png', size: 1000 })).toBeNull()
  expect(imageProblem({ type: 'image/png', size: 6 * 1024 * 1024 })).toBe('Images up to 5 MB')
  expect(imageProblem({ type: 'application/pdf', size: 10 })).toBe('PNG, JPEG, GIF or WebP only')
})

test('slash completion only at the start, file completion after @ anywhere', () => {
  const commands = [
    { name: 'compact', description: 'Summarize' },
    { name: 'clear', description: 'Start over' }
  ]
  expect(completion('/co', 3, commands, [])).toMatchObject({ kind: 'command', query: 'co', start: 0, items: [{ label: '/compact', insert: '/compact ' }] })
  expect(completion('fix /co', 7, commands, [])).toBeNull()
  expect(completion('see @src/pri', 12, [], ['src/pricing/Pricing.tsx', 'src/app.ts'])).toMatchObject({
    kind: 'file',
    query: 'src/pri',
    start: 4,
    items: [{ label: 'src/pricing/Pricing.tsx', insert: '@src/pricing/Pricing.tsx ' }]
  })
  expect(completion('mail me@home', 12, [], ['home.ts'])).toBeNull()
})

test('a path mention browses folders outside the chat, opening into a picked folder', () => {
  const entries = ['.env', 'infrastructure/', 'betfeel/', 'notes.md']
  expect(browsedFolder('see @../infra', 13)).toBe('../')
  expect(browsedFolder('see @~/', 7)).toBe('~/')
  expect(browsedFolder('see @src/', 9)).toBeNull()
  expect(completion('see @../infra', 13, [], ['infra.ts'], entries)).toMatchObject({
    kind: 'file',
    query: '../infra',
    start: 4,
    items: [{ label: '../infrastructure/', insert: '@../infrastructure/' }]
  })
  expect(completion('@/tmp/', 6, [], [], entries)?.items.map((item) => item.insert)).toEqual(['@/tmp/betfeel/', '@/tmp/infrastructure/', '@/tmp/notes.md '])
  expect(completion('@../.e', 6, [], [], entries)?.items.map((item) => item.label)).toEqual(['../.env'])
  expect(folderPath('../', '/a/b', '/home')).toBe('/a/b/../')
  expect(folderPath('~/x/', '/a/b', '/home')).toBe('/home/x/')
  expect(folderPath('/etc/', '/a/b', '/home')).toBe('/etc/')
})

test('switchWarning and formatTokens', () => {
  expect(switchWarning({ used: 9000 }, false)).toBeNull()
  expect(switchWarning({ used: 48000 }, false)).toEqual({ tokens: 48000 })
  expect(switchWarning(null, false)).toEqual({ tokens: null })
  expect(switchWarning(null, true)).toBeNull()
  expect(formatTokens(48123)).toBe('48k')
  expect(formatTokens(1234567)).toBe('1.2M')
})

test('a ! command from the transcript reads back', () => {
  const prompt = (command: string, stdout: string, stderr: string) => `<bash-input>${command}</bash-input>\n<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`
  expect(parseShellPrompt(prompt('ls', 'a\nb\n', ''))).toEqual({ command: 'ls', output: 'a\nb' })
  expect(parseShellPrompt(prompt('rm x', '', 'rm: x: No such file\nExit code 1'))).toEqual({ command: 'rm x', output: 'rm: x: No such file\nExit code 1' })
  expect(parseShellPrompt('hello')).toBeNull()
})
