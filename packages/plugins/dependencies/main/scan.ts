import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { readJsonFile } from '@treeix/host/paths'
import { isJson, stringValues, text } from '@treeix/shared/json'
import { DEPENDENCY_KINDS, type DependencyScan, type Package } from '../shared/types'

const exec = promisify(execFile)

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']
/** Files read at once */
const READ_BATCH = 64

const gitFiles = async (cwd: string, pathspecs: string[]): Promise<string[]> =>
  (await exec('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '--', ...pathspecs], { maxBuffer: 256 << 20 })).stdout.split('\n').filter(Boolean)

async function readPackage(worktreePath: string, manifest: string): Promise<Package | null> {
  const json = await readJsonFile(join(worktreePath, manifest))
  if (!isJson(json)) return null
  const folder = posix.dirname(manifest)
  return {
    name: text(json.name) || (folder === '.' ? 'root' : folder),
    version: text(json.version) || null,
    manifest,
    dependencies: DEPENDENCY_KINDS.flatMap((kind) => Object.entries(stringValues(json[kind])).map(([name, range]) => ({ name, range, kind })))
  }
}

type Resolver = { options: ts.CompilerOptions; cache?: ts.ModuleResolutionCache }

/** The tsconfig files of each folder that has some, parsed without listing their files */
function compilerOptionsFinder(worktreePath: string, configPaths: string[]): (file: string) => Resolver[] {
  const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] }
  const byFolder = new Map<string, Resolver[]>()
  for (const configPath of configPaths) {
    const absolute = join(worktreePath, configPath)
    const { config } = ts.readConfigFile(absolute, ts.sys.readFile)
    if (!config) continue
    const { options } = ts.parseJsonConfigFileContent(config, host, posix.dirname(absolute), undefined, absolute)
    const folder = posix.dirname(configPath)
    const cache = ts.createModuleResolutionCache(posix.dirname(absolute), (name) => name, options)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), { options, cache }])
  }
  const fallback: Resolver[] = [{ options: { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext } }]
  // The nearest folder with a tsconfig decides; a solution-style one with several configs tries each
  return (file) => {
    for (let folder = posix.dirname(file); ; folder = posix.dirname(folder)) {
      const found = byFolder.get(folder)
      if (found) return found
      if (folder === '.') return fallback
    }
  }
}

/** Every package.json, and which source file imports which, resolved the way TypeScript does, tsconfig paths included */
export async function scanDependencies(worktreePath: string): Promise<DependencyScan> {
  const listed = await gitFiles(worktreePath, [':(glob)**/package.json', ':(glob)**/tsconfig*.json', ...SOURCE_EXTENSIONS.map((extension) => `:(glob)**/*.${extension}`)])
  const manifests = listed.filter((path) => posix.basename(path) === 'package.json')
  const configs = listed.filter((path) => /^tsconfig.*\.json$/.test(posix.basename(path)))
  // ponytail: every source file is read once per scan; cap or cache by mtime if huge monorepos get slow
  const files = listed.filter((path) => SOURCE_EXTENSIONS.includes(posix.extname(path).slice(1)) && !path.endsWith('.d.ts'))
  const index = new Map(files.map((path, position) => [path, position]))
  const packages = (await Promise.all(manifests.map((manifest) => readPackage(worktreePath, manifest)))).filter((item) => item !== null)

  const optionsFor = compilerOptionsFinder(worktreePath, configs)
  const pairs = new Set<string>()
  const imports: [number, number][] = []
  for (let start = 0; start < files.length; start += READ_BATCH) {
    const batch = files.slice(start, start + READ_BATCH)
    const texts = await Promise.all(batch.map((path) => readFile(join(worktreePath, path), 'utf8').catch(() => '')))
    batch.forEach((path, offset) => {
      const from = start + offset
      const containing = join(worktreePath, path)
      for (const { fileName } of ts.preProcessFile(texts[offset], true, true).importedFiles) {
        for (const { options, cache } of optionsFor(path)) {
          const resolved = ts.resolveModuleName(fileName, containing, options, ts.sys, cache).resolvedModule?.resolvedFileName
          const target = resolved && !resolved.includes('/node_modules/') ? index.get(relative(worktreePath, resolved)) : undefined
          if (target === undefined) continue
          const key = `${from}>${target}`
          if (target !== from && !pairs.has(key)) {
            pairs.add(key)
            imports.push([from, target])
          }
          break
        }
      }
    })
  }
  return { packages, files, imports }
}
