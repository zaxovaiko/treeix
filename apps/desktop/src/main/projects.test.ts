import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { agentDirectories, childProjects } from './projects'

test('finds the repos under a folder that have their own agent setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projects-'))
  await mkdir(join(root, 'web', '.claude', 'agents'), { recursive: true })
  await mkdir(join(root, 'api'))
  await writeFile(join(root, 'api', 'AGENTS.md'), '')
  await mkdir(join(root, 'docs'))
  await mkdir(join(root, 'node_modules', 'x', '.claude'), { recursive: true })
  await mkdir(join(root, '.hidden', '.claude'), { recursive: true })
  expect((await childProjects(root)).sort()).toEqual([join(root, 'api'), join(root, 'web')])
  expect(await childProjects(join(root, 'missing'))).toEqual([])
})

test("a checkout and its worktrees load the folders the repo's Claude settings add, made absolute against the main checkout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'projects-')))
  const repo = join(root, 'betfeel')
  await mkdir(join(repo, '.claude'), { recursive: true })
  await mkdir(join(root, 'openora'))
  await mkdir(join(root, 'infra'))
  await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: ['../openora', '../gone'] } }))
  await writeFile(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { additionalDirectories: [join(root, 'infra')] } }))
  const git = (...args: string[]): void => void spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('add', '.claude/settings.json')
  git('commit', '-q', '-m', 'init')
  const worktree = join(repo, '.claude', 'worktrees', 'bf-1')
  git('worktree', 'add', '-q', '-b', 'bf-1', worktree)
  expect((await agentDirectories(worktree)).sort()).toEqual([join(root, 'infra'), join(root, 'openora')])
  expect((await agentDirectories(repo)).sort()).toEqual([join(root, 'infra'), join(root, 'openora')])
})
