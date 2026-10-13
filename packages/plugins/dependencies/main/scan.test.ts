import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanDependencies } from './scan'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-deps-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

test('scanDependencies reads package.json files and resolves relative, extensionless and tsconfig alias imports', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root })
  write('package.json', JSON.stringify({ name: 'repo', workspaces: ['apps/*', 'packages/*'] }))
  write('apps/web/package.json', JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { ui: 'workspace:*', react: '^19' } }))
  write('packages/ui/package.json', JSON.stringify({ name: 'ui', devDependencies: { typescript: '6' } }))
  write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext', paths: { '@ui/*': ['./packages/ui/src/*'] } } }))
  write('apps/web/src/main.tsx', "import { Button } from '@ui/button'\nimport { util } from './util.js'\nimport React from 'react'\n")
  write('apps/web/src/util.ts', "export const util = 1\nexport * from '../lib'\n")
  write('apps/web/lib/index.ts', 'export {}\n')
  write('packages/ui/src/button.tsx', 'export const Button = 1\n')
  write('node_modules/react/index.js', '')

  const scan = await scanDependencies(root)
  expect(scan.packages.map((item) => item.name).sort()).toEqual(['repo', 'ui', 'web'])
  expect(scan.packages.find((item) => item.name === 'web')?.dependencies).toContainEqual({ name: 'ui', range: 'workspace:*', kind: 'dependencies' })
  const edges = scan.imports.map(([from, to]) => `${scan.files[from]} > ${scan.files[to]}`).sort()
  expect(edges).toEqual(['apps/web/src/main.tsx > apps/web/src/util.ts', 'apps/web/src/main.tsx > packages/ui/src/button.tsx', 'apps/web/src/util.ts > apps/web/lib/index.ts'])
})
