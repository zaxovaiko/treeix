import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'
import { supportsLanguageService } from '../shared/languages'
import type { CodeLocation, HoverInfo, NavigationKind, SymbolTarget } from '../shared/types'

const MAX_SERVICES = 3

type Project = { service: ts.LanguageService; roots: Set<string> }
/** Insertion order doubles as recency, so the first entry is the least recently used */
const projects = new Map<string, Project>()

function createProject(configPath: string | undefined, directory: string): Project {
  const parsed = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })
    : undefined
  const options: ts.CompilerOptions = parsed?.options ?? { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext }
  const roots = new Set(parsed?.fileNames ?? [])
  const version = (fileName: string): string => {
    try {
      return String(statSync(fileName).mtimeMs)
    } catch {
      return '0'
    }
  }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...roots],
    getScriptVersion: version,
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => directory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getProjectReferences: () => parsed?.projectReferences,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath
  }
  return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), roots }
}

/** One service per nearest tsconfig, so monorepo packages resolve with their own settings */
function projectFor(worktreePath: string, fileName: string): Project {
  const configPath = ts.findConfigFile(dirname(fileName), ts.sys.fileExists)
  const insideWorktree = configPath && !relative(worktreePath, configPath).startsWith('..')
  const key = insideWorktree ? configPath : `${worktreePath}/`
  let project = projects.get(key)
  if (project) projects.delete(key)
  else project = createProject(insideWorktree ? configPath : undefined, insideWorktree ? dirname(configPath) : worktreePath)
  projects.set(key, project)
  // ponytail: whole programs stay in memory, evict the oldest past a few; a shared document registry would cut this further
  for (const [staleKey, stale] of projects) {
    if (projects.size <= MAX_SERVICES) break
    stale.service.dispose()
    projects.delete(staleKey)
  }
  // Files outside the config's include (tests, scripts) still get answers
  project.roots.add(fileName)
  return project
}

function positionOf(project: Project, fileName: string, target: SymbolTarget): number | null {
  const sourceFile = project.service.getProgram()?.getSourceFile(fileName)
  if (!sourceFile) return null
  const lineStarts = sourceFile.getLineStarts()
  if (target.line < 1 || target.line > lineStarts.length) return null
  return ts.getPositionOfLineAndCharacter(sourceFile, target.line - 1, target.column)
}

function toLocation(project: Project, worktreePath: string, fileName: string, start: number, isDefinition = false): CodeLocation | null {
  const path = relative(worktreePath, fileName)
  if (path.startsWith('..') || isAbsolute(path)) return null
  const sourceFile = project.service.getProgram()?.getSourceFile(fileName)
  if (!sourceFile) return null
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
  const lineStart = sourceFile.getLineStarts()[line]
  const lineEnd = sourceFile.getLineEndOfPosition(start)
  return { path, line: line + 1, column: character, text: sourceFile.text.slice(lineStart, lineEnd).trim(), isDefinition }
}

const byPosition = (a: CodeLocation, b: CodeLocation): number => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column

/** TypeScript leaves isDefinition unset on references, so mark the spans go-to-definition would land on */
function referenceSpans(service: ts.LanguageService, fileName: string, position: number): { fileName: string; start: number; isDefinition: boolean }[] {
  const definitions = new Set((service.getDefinitionAtPosition(fileName, position) ?? []).map((entry) => `${entry.fileName}:${entry.textSpan.start}`))
  return (service.findReferences(fileName, position) ?? []).flatMap((symbol) =>
    symbol.references.map((entry) => ({
      fileName: entry.fileName,
      start: entry.textSpan.start,
      isDefinition: definitions.has(`${entry.fileName}:${entry.textSpan.start}`)
    }))
  )
}

/** Resolves with null when the file is not part of any TypeScript program */
export function navigate(worktreePath: string, kind: NavigationKind, target: SymbolTarget): CodeLocation[] | null {
  const fileName = resolve(worktreePath, target.path)
  if (!supportsLanguageService(fileName)) return null
  const project = projectFor(worktreePath, fileName)
  const position = positionOf(project, fileName, target)
  if (position === null) return null
  const { service } = project
  const spans: { fileName: string; start: number; isDefinition?: boolean }[] =
    kind === 'definition'
      ? (service.getDefinitionAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
      : kind === 'typeDefinition'
        ? (service.getTypeDefinitionAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
        : kind === 'implementation'
          ? (service.getImplementationAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
          : referenceSpans(service, fileName, position)
  // A symbol and its import alias report overlapping spans, keep one per position and remember if any marked it a definition
  const unique = new Map<string, CodeLocation>()
  for (const span of spans) {
    const location = toLocation(project, worktreePath, span.fileName, span.start, span.isDefinition)
    if (!location) continue
    const key = `${location.path}:${location.line}:${location.column}`
    const existing = unique.get(key)
    unique.set(key, { ...location, isDefinition: Boolean(existing?.isDefinition || location.isDefinition) })
  }
  return [...unique.values()]
    .sort(byPosition)
}

export function hover(worktreePath: string, target: SymbolTarget): HoverInfo | null {
  const fileName = resolve(worktreePath, target.path)
  if (!supportsLanguageService(fileName)) return null
  const project = projectFor(worktreePath, fileName)
  const position = positionOf(project, fileName, target)
  const info = position === null ? undefined : project.service.getQuickInfoAtPosition(fileName, position)
  if (!info) return null
  const tags = (info.tags ?? []).map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text)}`.trim())
  return {
    signature: ts.displayPartsToString(info.displayParts),
    documentation: [ts.displayPartsToString(info.documentation), ...tags].filter(Boolean).join('\n\n')
  }
}
