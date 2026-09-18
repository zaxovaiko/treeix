import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hover, navigate } from './languageService'

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
})
