import { expect, test } from 'bun:test'
import { isEnvPath, isTemplate, parseWithLines, setValue } from './dotenv'

test('env file filter', () => {
  for (const path of ['.env', '.env.local', 'apps/web/.env.production.local', 'apps/api/.env.example']) expect(isEnvPath(path)).toBe(true)
  for (const path of ['env', '.envrc', 'src/env.ts', 'a/.env/x', 'node_modules/pkg/.env', '.env.local.bak~']) expect(isEnvPath(path)).toBe(false)
  expect(['.env.example', 'a/.env.sample', '.env.template', '.env.dist', '.env.local'].map(isTemplate)).toEqual([true, true, true, true, false])
})

test('parseWithLines keeps the line that wins', () => {
  expect(parseWithLines('# c\nA=1\nexport B="x"\nA=2\n')).toEqual([
    { name: 'A', value: '2', line: 4 },
    { name: 'B', value: 'x', line: 3 }
  ])
  expect(parseWithLines('X=0\na.b=1\n').map((entry) => entry.line)).toEqual([1, 2])
})

test('setValue rewrites only the line, in its own style', () => {
  const text = '# db\nDATABASE_URL=postgres://a\nexport PORT=3000 # api\nNAME="Blurify Admin"\nKEY=\'q\'\n\nLAST=1'
  const lines = (next: string): string[] => next.split('\n')
  expect(lines(setValue(text, 'PORT', '3001'))).toEqual(lines(text).map((line) => (line.startsWith('export PORT') ? 'export PORT=3001 # api' : line)))
  expect(setValue(text, 'NAME', 'Other')).toContain('\nNAME="Other"\n')
  expect(setValue(text, 'KEY', 'r')).toContain("\nKEY='r'\n")
  // No trailing newline stays that way
  expect(setValue(text, 'LAST', '2').endsWith('\nLAST=2')).toBe(true)
  // Values that would not read back plain get quoted
  expect(setValue(text, 'DATABASE_URL', 'a # b')).toContain('\nDATABASE_URL="a # b"\n')
  expect(setValue('A=1\n', 'A', 'say "hi"')).toBe('A=say "hi"\n')
  expect(setValue('A=1\n', 'A', '"hi" there')).toBe(`A='"hi" there'\n`)
  expect(setValue('A=1\n', 'A', ' padded ')).toBe('A=" padded "\n')
})

test('setValue edits the last of duplicate keys and keeps CRLF', () => {
  expect(setValue('A=1\nB=2\nA=3\n', 'A', '4')).toBe('A=1\nB=2\nA=4\n')
  expect(setValue('A=1\r\nB=2\r\n', 'A', '5')).toBe('A=5\r\nB=2\r\n')
})

test('setValue replaces a quoted value spanning lines', () => {
  const text = 'KEY="-----BEGIN\nabc\n-----END" # pem\nNEXT=1\n'
  expect(setValue(text, 'KEY', 'x')).toBe('KEY="x" # pem\nNEXT=1\n')
})

test('setValue appends a missing name and round-trips through parseEnv', () => {
  expect(setValue('A=1', 'B', 'two words')).toBe('A=1\nB=two words\n')
  expect(setValue('', 'B', '1')).toBe('B=1\n')
  const written = setValue('A=1\n', 'B', 'line1\nline2')
  expect(parseWithLines(written).find((entry) => entry.name === 'B')?.value).toBe('line1\nline2')
  expect(() => setValue('', 'not a name', '1')).toThrow()
})
