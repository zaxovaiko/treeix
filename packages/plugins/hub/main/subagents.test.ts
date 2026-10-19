import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSubagent } from './subagents'

const define = async (repo: string, name: string, model: string): Promise<void> => {
  await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
  await mkdir(join(repo, '.git'), { recursive: true })
  await writeFile(join(repo, '.claude', 'agents', `${name}.md`), `---\nname: ${name}\nmodel: ${model}\n---\nPlan in ${repo}.\n`)
}

test("a step's subagent is its own repo's, or the list of repos that define it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-'))
  await define(join(root, 'api'), 'planner', 'opus')
  await define(join(root, 'web'), 'planner', 'opus')
  expect(await resolveSubagent('planner', join(root, 'api'))).toEqual({ instructions: `Plan in ${join(root, 'api')}.`, model: 'opus' })
  const listed = await resolveSubagent('planner', root)
  expect(listed?.model).toBe('opus')
  expect(listed?.instructions).toContain(join(root, 'web', '.claude', 'agents', 'planner.md'))
  expect(await resolveSubagent('tester', root)).toBeNull()
})

test("a ticket's worktree runs the subagents its repo generates and ignores, from the main checkout", async () => {
  const repo = await mkdtemp(join(tmpdir(), 'subagents-'))
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q')
  await writeFile(join(repo, '.gitignore'), '.claude/\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  await define(repo, 'builder', 'opus')
  const worktree = join(repo, '.claude', 'worktrees', 'bf-1')
  git('worktree', 'add', '-q', '-b', 'bf-1', worktree)
  expect(await resolveSubagent('builder', worktree)).toEqual({ instructions: `Plan in ${repo}.`, model: 'opus' })
  expect(await resolveSubagent('tester', worktree)).toBeNull()
})
