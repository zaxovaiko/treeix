import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

// What tells a project with its own agent setup apart from any other folder
const MARKERS = ['.claude', '.codex', '.rulesync', 'CLAUDE.md', 'AGENTS.md']

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** The projects right under a folder that holds several repos, each with its own instructions, skills and subagents */
export async function childProjects(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').map((entry) => join(folder, entry.name))
  const marked = await Promise.all(children.map(async (child) => (await Promise.all(MARKERS.map((marker) => exists(join(child, marker))))).some(Boolean)))
  return children.filter((_, index) => marked[index])
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/** The extra folders a checkout's Claude settings name (permissions.additionalDirectories), absolute against the checkout */
async function settingsDirectories(checkout: string): Promise<string[]> {
  const files = ['settings.json', 'settings.local.json'].map((name) => join(checkout, '.claude', name))
  const lists = await Promise.all(
    files.map(async (file) => {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
        const listed: unknown =
          parsed &&
          typeof parsed === 'object' &&
          'permissions' in parsed &&
          parsed.permissions &&
          typeof parsed.permissions === 'object' &&
          'additionalDirectories' in parsed.permissions
            ? parsed.permissions.additionalDirectories
            : null
        return isStringList(listed) ? listed : []
      } catch {
        return []
      }
    })
  )
  return lists.flat().map((entry) => (entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : isAbsolute(entry) ? entry : resolve(checkout, entry)))
}

/** The main checkout a linked worktree belongs to, or null for a main checkout or a folder outside git */
export async function mainCheckoutOf(folder: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
    const [commonDir, top] = stdout.trim().split('\n')
    const main = dirname(commonDir)
    return main === top ? null : main
  } catch {
    return null
  }
}

/**
 * What an agent started in `cwd` loads besides it: the projects under it, and in a linked worktree the folders its repo's Claude settings add.
 * Claude resolves those relative to the cwd, which from .claude/worktrees/<branch> points nowhere, so they are passed made absolute against the main checkout
 */
export async function agentDirectories(cwd: string): Promise<string[]> {
  const added = await settingsDirectories((await mainCheckoutOf(cwd)) ?? cwd)
  const present = await Promise.all(added.map(exists))
  return [...new Set([...(await childProjects(cwd)), ...added.filter((_, index) => present[index])])]
}
