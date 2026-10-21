import { expect, test } from 'bun:test'
import {
  browsedFolder,
  builtinOf,
  completion,
  folderPath,
  formatTokens,
  imageProblem,
  parseShellPrompt,
  shellCommandOf,
  shellPrompt,
  switchWarning,
  withBuiltins,
  withMentions
} from './composer'

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

test('built-in /clear unless the agent has its own', () => {
  expect(withBuiltins([]).map((command) => command.name)).toEqual(['clear'])
  expect(withBuiltins([{ name: 'clear', description: 'Agent clear' }])).toEqual([{ name: 'clear', description: 'Agent clear' }])
  expect(builtinOf(' /clear ', [])).toBe('clear')
  expect(builtinOf('/clear', [{ name: 'clear' }])).toBeNull()
  expect(builtinOf('/clear the cache', [])).toBeNull()
  expect(builtinOf('/compact', [])).toBeNull()
})

test('withMentions appends dropped paths, relative inside the folder', () => {
  expect(withMentions('', ['/repo/src/a.ts'], '/repo')).toBe('@src/a.ts ')
  expect(withMentions('look at', ['/repo/a.ts', '/tmp/b.log'], '/repo')).toBe('look at @a.ts @/tmp/b.log ')
  expect(withMentions('see ', ['/repository/x'], '/repo')).toBe('see @/repository/x ')
})

test('a ! line is a shell command, and its prompt reads back', () => {
  expect(shellCommandOf('! rm a.lock')).toBe('rm a.lock')
  expect(shellCommandOf('!git status')).toBe('git status')
  expect(shellCommandOf('!')).toBeNull()
  expect(shellCommandOf('fix it!')).toBeNull()
  expect(parseShellPrompt(shellPrompt('ls', { stdout: 'a\nb\n', stderr: '' }))).toEqual({ command: 'ls', output: 'a\nb' })
  expect(parseShellPrompt(shellPrompt('rm x', { stdout: '', stderr: 'rm: x: No such file\nExit code 1' }))).toEqual({ command: 'rm x', output: 'rm: x: No such file\nExit code 1' })
  expect(parseShellPrompt('hello')).toBeNull()
})
