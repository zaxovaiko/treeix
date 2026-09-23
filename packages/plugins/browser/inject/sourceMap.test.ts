import { expect, test } from 'bun:test'
import { originalPlace, projectPath } from './sourceMap'

// Line 1 column 0 comes from source line 1, line 2 column 0 from line 2 and line 2 column 4 from line 4
const map = { sources: ['src/a.tsx'], mappings: 'AAAA;AACA,IAEA' }

test('originalPlace finds the source line of a generated position', () => {
  expect(originalPlace(map, 1, 6)).toMatchObject({ sourceIndex: 0, line: 3 })
  expect(originalPlace(map, 1, 2)).toMatchObject({ sourceIndex: 0, line: 1 })
  expect(originalPlace(map, 0, 0)).toMatchObject({ sourceIndex: 0, line: 0 })
})

test('originalPlace follows the section of an index map', () => {
  const index = { sections: [{ offset: { line: 0, column: 0 }, map: { sources: ['x.ts'], mappings: 'AAAA' } }, { offset: { line: 10, column: 0 }, map }] }
  expect(originalPlace(index, 11, 6)).toMatchObject({ line: 3, map })
})

test('projectPath strips bundler prefixes', () => {
  expect(projectPath('turbopack:///[project]/src/components/Avatar.tsx', 'http://localhost:3000/a.js.map')).toBe('src/components/Avatar.tsx')
  expect(projectPath('webpack://_N_E/./src/app/page.tsx', 'http://localhost:3000/a.js.map')).toBe('src/app/page.tsx')
  expect(projectPath('../src/a.tsx', 'http://localhost:5173/dist/x.js.map')).toBe('src/a.tsx')
})
