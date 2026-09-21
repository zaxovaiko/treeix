import { execFile } from 'node:child_process'
import { type Stats, unwatchFile, watchFile } from 'node:fs'
import { copyFile, constants, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { insideWorktree } from '@treeix/host/paths'
import { annotations, setAnnotation } from '../shared/classify'
import type { Annotation, CopyMode, EnvEdit, EnvFile, EnvTemplate, Usage, WorktreeEnv } from '../shared/types'
import { isEnvName, isEnvPath, isTemplate, parseWithLines, setValue } from './dotenv'

const exec = promisify(execFile)
const ENV_GLOB = ':(glob)**/.env*'
const USAGE_LIMIT = 20

const gitLines = async (cwd: string, args: string[]): Promise<string[]> =>
  (await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 << 20 })).stdout.split('\n').filter(Boolean)

const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null)
const folderOf = (path: string): string => posix.dirname(path)

/** Tracked, untracked and gitignored env files; git answers from the index and ignore rules, no directory walk of our own */
async function envPaths(worktreePath: string): Promise<{ paths: string[]; tracked: Set<string> }> {
  const [tracked, untracked, ignored] = await Promise.all([
    gitLines(worktreePath, ['ls-files', '-c', '--', ENV_GLOB]),
    gitLines(worktreePath, ['ls-files', '-o', '--exclude-standard', '--', ENV_GLOB]),
    gitLines(worktreePath, ['ls-files', '-o', '-i', '--exclude-standard', '--', ENV_GLOB])
  ])
  const paths = [...new Set([...tracked, ...untracked, ...ignored])].filter(isEnvPath).sort()
  return { paths, tracked: new Set(tracked) }
}

/** Dependencies of the nearest package.json at or above the file, inside the worktree */
async function frameworksOf(worktreePath: string, file: string): Promise<string[]> {
  for (let folder = folderOf(file); ; folder = folderOf(folder)) {
    const manifest = await readText(join(worktreePath, folder, 'package.json'))
    if (manifest !== null) {
      try {
        const parsed: unknown = JSON.parse(manifest)
        const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
        const names = (field: unknown): string[] => (typeof field === 'object' && field !== null ? Object.keys(field) : [])
        return [...names(record.dependencies), ...names(record.devDependencies)]
      } catch {
        return []
      }
    }
    if (folder === '.') return []
  }
}

export async function scanWorktree(worktreePath: string): Promise<WorktreeEnv> {
  const { paths, tracked } = await envPaths(worktreePath)
  const files: EnvFile[] = []
  const templates: EnvTemplate[] = []
  const marks: WorktreeEnv['annotations'] = {}
  for (const path of paths) {
    const text = await readText(join(worktreePath, path))
    if (text === null) continue
    const frameworks = await frameworksOf(worktreePath, path)
    const vars = parseWithLines(text)
    if (!isTemplate(path)) files.push({ path, vars, frameworks, tracked: tracked.has(path) })
    else templates.push({ path, names: vars.map((entry) => entry.name), frameworks })
    if (posix.basename(path) === '.env.example') marks[folderOf(path)] = annotations(text)
  }
  return { path: worktreePath, files, templates, annotations: marks }
}

/** Applies reviewed edits file by file, each file read once and written once */
export async function writeEdits(edits: EnvEdit[]): Promise<void> {
  const byFile = Map.groupBy(edits, (edit) => insideWorktree(edit.worktreePath, edit.file))
  for (const [absolute, fileEdits] of byFile) {
    if (!isEnvPath(fileEdits[0].file) || isTemplate(fileEdits[0].file)) throw new Error(`${fileEdits[0].file} is not an env file`)
    const text = fileEdits.reduce((current, edit) => setValue(current, edit.name, edit.value), (await readText(absolute)) ?? '')
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, text, 'utf8')
  }
}

/** Writes the mark into the folder's .env.example, creating it when there is none */
export async function markName(worktreePath: string, folder: string, name: string, annotation: Annotation): Promise<void> {
  const absolute = insideWorktree(worktreePath, posix.join(folder, '.env.example'))
  await writeFile(absolute, setAnnotation((await readText(absolute)) ?? '', name, annotation), 'utf8')
}

/**
 * Gives a worktree main's env files at the same paths: copied, symlinked, or started from the folder's .env.example.
 * Files that already exist are left alone. Returns how many were created.
 */
export async function copyFromMain(mainPath: string, worktreePath: string, files: string[], mode: CopyMode): Promise<number> {
  let created = 0
  for (const file of files.filter((path) => isEnvPath(path) && !isTemplate(path))) {
    const source = mode === 'example' ? insideWorktree(worktreePath, posix.join(folderOf(file), '.env.example')) : insideWorktree(mainPath, file)
    const target = insideWorktree(worktreePath, file)
    await mkdir(dirname(target), { recursive: true })
    const done = await (mode === 'symlink' ? symlink(source, target) : copyFile(source, target, constants.COPYFILE_EXCL)).then(
      () => true,
      () => false
    )
    if (done) created++
  }
  return created
}

const WATCH_INTERVAL_MS = 1000
let watching: { absolute: string; listener: (current: Stats, previous: Stats) => void }[] = []

export function stopWatching(): void {
  watching.forEach(({ absolute, listener }) => unwatchFile(absolute, listener))
  watching = []
}

/**
 * Watches one worktree's env and template files at a time, replacing whatever was watched before. Stat polling, like
 * the host's editor, because editors and agents replace files by rename, which fs.watch stops following
 */
export function watchWorktree(worktreePath: string, files: string[], onChange: () => void): void {
  stopWatching()
  watching = files.filter(isEnvPath).map((file) => {
    const absolute = insideWorktree(worktreePath, file)
    const listener = (current: Stats, previous: Stats): void => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) onChange()
    }
    watchFile(absolute, { interval: WATCH_INTERVAL_MS, persistent: false }, listener)
    return { absolute, listener }
  })
}

/** Where code reads the name: process.env.X, process.env['X'], import.meta.env.X, env.X; tracked files only */
export async function usages(worktreePath: string, name: string): Promise<Usage[]> {
  if (!isEnvName(name)) return []
  const patterns = [`env\\.${name}([^A-Za-z0-9_]|$)`, `env\\[['"]${name}['"]\\]`]
  const lines = await gitLines(worktreePath, ['grep', '-n', '-I', '-E', ...patterns.flatMap((pattern) => ['-e', pattern])]).catch(() => [])
  return lines
    .map((line) => line.match(/^(.+?):(\d+):/))
    .flatMap((match) => (match && !isEnvPath(match[1]) ? [{ path: match[1], line: Number(match[2]) }] : []))
    .slice(0, USAGE_LIMIT)
}
