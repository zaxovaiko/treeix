import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyFromMain, markName, scanWorktree, usages, writeEdits } from './env'

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'treeix-env-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.env.example', '.gitignore', 'apps/web/package.json', 'apps/web/src/api.ts'], { cwd: root })
  return root
}

const files = {
  '.gitignore': '.env\n.env.local\nnode_modules\n',
  '.env': 'PORT=3000\n',
  '.env.example': '# @secret\nPORT=\nREDIS_URL=\n',
  'apps/web/package.json': '{"dependencies":{"next":"15"}}',
  'apps/web/.env.local': 'NEXT_PUBLIC_API_URL=http://localhost\n',
  'apps/web/src/api.ts': 'fetch(process.env.NEXT_PUBLIC_API_URL)\nconst url = import.meta.env["NEXT_PUBLIC_API_URL"]\n',
  'node_modules/pkg/.env': 'X=1\n'
}

test('scanWorktree finds env files and templates, with frameworks and annotations', async () => {
  const root = repo(files)
  const env = await scanWorktree(root)
  expect(env.files.map((file) => [file.path, file.frameworks, file.tracked])).toEqual([
    ['.env', [], false],
    ['apps/web/.env.local', ['next'], false]
  ])
  expect(env.templates).toEqual([{ path: '.env.example', names: ['PORT', 'REDIS_URL'], frameworks: [] }])
  expect(env.annotations).toEqual({ '.': { PORT: 'secret' } })
  expect(await usages(root, 'NEXT_PUBLIC_API_URL')).toEqual([
    { path: 'apps/web/src/api.ts', line: 1 },
    { path: 'apps/web/src/api.ts', line: 2 }
  ])
})

test('writes stay inside the worktree and only touch env files', async () => {
  const root = repo(files)
  await writeEdits([
    { worktreePath: root, file: '.env', name: 'PORT', value: '3001' },
    { worktreePath: root, file: '.env', name: 'REDIS_URL', value: 'redis://localhost' },
    { worktreePath: root, file: 'apps/api/.env', name: 'A', value: '1' }
  ])
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('PORT=3001\nREDIS_URL=redis://localhost\n')
  expect(readFileSync(join(root, 'apps/api/.env'), 'utf8')).toBe('A=1\n')
  await expect(writeEdits([{ worktreePath: root, file: '../.env', name: 'A', value: '1' }])).rejects.toThrow()
  await expect(writeEdits([{ worktreePath: root, file: 'src/api.ts', name: 'A', value: '1' }])).rejects.toThrow()
  await markName(root, '.', 'REDIS_URL', 'public')
  expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe('# @secret\nPORT=\n# @public\nREDIS_URL=\n')
})

test('copyFromMain creates missing files and never overwrites', async () => {
  const main = repo(files)
  const fresh = repo({ ...files, '.env': 'PORT=1\n', 'apps/web/.env.local': '' })
  execFileSync('rm', [join(fresh, 'apps/web/.env.local')])
  expect(await copyFromMain(main, fresh, ['.env', 'apps/web/.env.local'], 'copy')).toBe(1)
  expect(readFileSync(join(fresh, '.env'), 'utf8')).toBe('PORT=1\n')
  expect(readFileSync(join(fresh, 'apps/web/.env.local'), 'utf8')).toBe(files['apps/web/.env.local'])
  const other = repo(files)
  execFileSync('rm', [join(other, '.env')])
  expect(await copyFromMain(main, other, ['.env'], 'example')).toBe(1)
  expect(readFileSync(join(other, '.env'), 'utf8')).toBe(files['.env.example'])
})
