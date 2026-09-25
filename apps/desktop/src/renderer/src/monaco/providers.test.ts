import { expect, test } from 'bun:test'
import { completionKind, toCodePosition, toMonacoRange } from './providers'

test('converts between TypeScript and Monaco coordinates', () => {
  expect(toCodePosition({ lineNumber: 3, column: 5 })).toEqual({ line: 3, column: 4 })
  expect(toMonacoRange({ start: { line: 1, column: 0 }, end: { line: 2, column: 3 } })).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })
})

test('maps TypeScript completion kinds to Monaco icons', () => {
  expect(completionKind('method')).toBe('Method')
  expect(completionKind('const')).toBe('Constant')
  expect(completionKind('interface')).toBe('Interface')
  expect(completionKind('something new')).toBe('Property')
})
