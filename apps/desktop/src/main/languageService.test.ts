import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDocument, completionDetails, completions, diagnostics, hover, navigate, signatureHelp } from './languageService'

test('finds definitions, references and hover info through the tsconfig program', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  writeFileSync(join(root, 'status.ts'), '/** Grant lifecycle */\nexport type Status = "pending" | "active"\n')
  writeFileSync(join(root, 'use.ts'), 'import type { Status } from "./status"\nconst current: Status = "pending"\nexport const other: Status = current\n')
  const target = { path: 'use.ts', line: 2, column: 15, symbol: 'Status' }

  expect(navigate(root, 'definition', target)).toEqual([{ path: 'status.ts', line: 2, column: 12, text: 'export type Status = "pending" | "active"', isDefinition: false }])
  const references = navigate(root, 'references', target) ?? []
  expect(references.map((location) => `${location.path}:${location.line}`)).toEqual(['status.ts:2', 'use.ts:1', 'use.ts:2', 'use.ts:3'])
  expect(references[0].isDefinition).toBe(true)
  expect(hover(root, target)).toEqual({ signature: '(alias) type Status = "pending" | "active"\nimport Status', documentation: 'Grant lifecycle' })
  expect(navigate(root, 'references', { ...target, path: 'notes.md' })).toBeNull()
  // A column past the line end (a stale target) clamps to the line end instead of throwing
  expect(() => hover(root, { ...target, column: 500 })).not.toThrow()
  // Unsaved text with a line added above: the target's position points into that text, not the file on disk
  const edited = `\n${readFileSync(join(root, 'use.ts'), 'utf8')}`
  diagnostics(root, 'use.ts', edited)
  expect(hover(root, { ...target, line: 3, text: edited })?.signature).toBe('(alias) type Status = "pending" | "active"\nimport Status')
})

test('answers from unsaved text: completions, auto-imports, signatures, diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' }, include: ['*.ts'] }))
  writeFileSync(join(root, 'grant.ts'), 'export function grant(id: string, days: number): void {}\n')
  writeFileSync(join(root, 'use.ts'), '')

  const members = completions(root, 'use.ts', 'const list = [1, 2]\nlist.ma', { line: 2, column: 7 }) ?? []
  expect(members.some((item) => item.name === 'map')).toBe(true)

  const imported = (completions(root, 'use.ts', 'gran', { line: 1, column: 4 }) ?? []).find((item) => item.name === 'grant')
  expect(imported?.source).not.toBeNull()
  const details = completionDetails(root, 'use.ts', 'gran', { line: 1, column: 4 }, 'grant', imported?.source ?? null, imported?.data ?? null)
  expect(details?.edits.map((edit) => edit.text).join('')).toContain('import { grant } from "./grant"')

  const signature = signatureHelp(root, 'use.ts', 'import { grant } from "./grant"\ngrant("a", ', { line: 2, column: 11 })
  expect(signature?.signatures[0].label).toBe('grant(id: string, days: number): void')
  expect(signature?.activeParameter).toBe(1)

  const errors = diagnostics(root, 'use.ts', 'const count: number = "x"\n') ?? []
  expect(errors.map((error) => [error.code, error.range.start.line, error.severity])).toEqual([[2322, 1, 'error']])

  // Closing drops the unsaved text: navigation reads the empty file on disk again
  closeDocument(root, 'use.ts')
  expect(diagnostics(root, 'use.ts', '')).toEqual([])
  expect(completions(root, 'notes.md', '', { line: 1, column: 0 })).toBeNull()
  expect(diagnostics(root, 'notes.md', '')).toBeNull()
})

test('a solution-style tsconfig answers through the referenced project that includes the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))
  writeFileSync(join(root, 'tsconfig.app.json'), JSON.stringify({ compilerOptions: { composite: true, strict: true }, include: ['*.ts'] }))
  writeFileSync(join(root, 'use.ts'), '')

  const members = completions(root, 'use.ts', 'const list = [1, 2]\nlist.ma', { line: 2, column: 7 }) ?? []
  expect(members.some((item) => item.name === 'map')).toBe(true)
})

test('text sent after the editor closed does not come back as unsaved text', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  writeFileSync(join(root, 'use.ts'), 'export const disk = 1\nexport const also = 2\n')
  const stale = '\nexport const stale = 1\n'

  diagnostics(root, 'use.ts', stale)
  closeDocument(root, 'use.ts')
  navigate(root, 'definition', { path: 'use.ts', line: 2, column: 13, symbol: 'stale', text: stale })
  expect(hover(root, { path: 'use.ts', line: 1, column: 13, symbol: 'disk' })?.signature).toBe('const disk: 1')
})

test('references to a file shared by referenced projects come from all of them', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.web.json' }] }))
  writeFileSync(join(root, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { composite: true, strict: true }, include: ['shared.ts', 'main.ts'] }))
  writeFileSync(join(root, 'tsconfig.web.json'), JSON.stringify({ compilerOptions: { composite: true, strict: true }, include: ['shared.ts', 'app.ts'] }))
  writeFileSync(join(root, 'shared.ts'), 'export const shared = 1\n')
  writeFileSync(join(root, 'main.ts'), 'import { shared } from "./shared"\nexport const main = shared\n')
  writeFileSync(join(root, 'app.ts'), 'import { shared } from "./shared"\nexport const app = shared\n')

  const references = navigate(root, 'references', { path: 'shared.ts', line: 1, column: 13, symbol: 'shared' }) ?? []
  expect(references.map((location) => `${location.path}:${location.line}`)).toEqual(['app.ts:1', 'app.ts:2', 'main.ts:1', 'main.ts:2', 'shared.ts:1'])
})
