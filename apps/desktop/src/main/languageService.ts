import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'
import { supportsLanguageService } from '../shared/languages'
import type { CodeDiagnostic, CodeLocation, CodePosition, CodeRange, CompletionDetails, CompletionItem, HoverInfo, NavigationKind, SignatureHelp, SymbolTarget } from '../shared/types'

// Solution-style configs give a worktree two or more programs (node and web), so fit a few worktrees' worth
const MAX_SERVICES = 6

type Project = { service: ts.LanguageService; roots: Set<string> }
/** Insertion order doubles as recency, so the first entry is the least recently used */
const projects = new Map<string, Project>()

/** Unsaved editor text by absolute file name; its version makes the program re-read the file */
const overlays = new Map<string, { text: string; version: number }>()
let overlayVersion = 0

function setOverlay(fileName: string, text: string | null): void {
  if (text === null) overlays.delete(fileName)
  else if (overlays.get(fileName)?.text !== text) overlays.set(fileName, { text, version: ++overlayVersion })
}

const PREFERENCES: ts.UserPreferences = {
  includeCompletionsForModuleExports: true,
  includeCompletionsWithInsertText: true,
  includeCompletionsWithSnippetText: false,
  importModuleSpecifierPreference: 'shortest'
}

const parseConfig = (configPath: string): ts.ParsedCommandLine | undefined =>
  ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })

function createProject(configPath: string | undefined, directory: string): Project {
  const parsed = configPath ? parseConfig(configPath) : undefined
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
    getScriptVersion: (fileName) => {
      const overlay = overlays.get(fileName)
      return overlay ? `overlay:${overlay.version}` : version(fileName)
    },
    getScriptSnapshot: (fileName) => {
      const text = overlays.get(fileName)?.text ?? ts.sys.readFile(fileName)
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

const owners = new Map<string, (string | undefined)[]>()
/**
 * The nearest tsconfig, or for a solution-style one (`files: []` plus references) every referenced
 * config that includes the file, like tsserver: the solution's own program redirects the file to
 * a build output and never holds its source. The first entry answers single-program requests
 */
function ownerConfigs(fileName: string): (string | undefined)[] {
  const cached = owners.get(fileName)
  if (cached) return cached
  const nearest = ts.findConfigFile(dirname(fileName), ts.sys.fileExists)
  const parsed = nearest ? parseConfig(nearest) : undefined
  const referenced =
    parsed && !parsed.fileNames.includes(fileName)
      ? (parsed.projectReferences ?? []).map(ts.resolveProjectReferencePath).filter((reference) => parseConfig(reference)?.fileNames.includes(fileName))
      : []
  const configs = referenced.length > 0 ? referenced : [nearest]
  owners.set(fileName, configs)
  return configs
}

/** One service per owning tsconfig, so monorepo packages resolve with their own settings */
function projectFor(worktreePath: string, fileName: string, configPath = ownerConfigs(fileName)[0]): Project {
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

function positionOf(project: Project, fileName: string, target: CodePosition): number | null {
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

function spansAt(service: ts.LanguageService, kind: NavigationKind, fileName: string, position: number): { fileName: string; start: number; isDefinition?: boolean }[] {
  return kind === 'definition'
    ? (service.getDefinitionAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
    : kind === 'typeDefinition'
      ? (service.getTypeDefinitionAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
      : kind === 'implementation'
        ? (service.getImplementationAtPosition(fileName, position) ?? []).map((entry) => ({ fileName: entry.fileName, start: entry.textSpan.start }))
        : referenceSpans(service, fileName, position)
}

/** Resolves with null when the file is not part of any TypeScript program */
export function navigate(worktreePath: string, kind: NavigationKind, target: SymbolTarget): CodeLocation[] | null {
  const fileName = resolve(worktreePath, target.path)
  if (!supportsLanguageService(fileName)) return null
  // Only an open editor's text: after its tab closed, a stale cursor target must not bring the text back
  if (target.text !== undefined && overlays.has(fileName)) setOverlay(fileName, target.text)
  // References to a file shared by several referenced projects (src/shared) live in all of them
  const configs = kind === 'references' ? ownerConfigs(fileName) : [ownerConfigs(fileName)[0]]
  const locations: CodeLocation[] = []
  let answered = false
  for (const configPath of configs) {
    const project = projectFor(worktreePath, fileName, configPath)
    const position = positionOf(project, fileName, target)
    if (position === null) continue
    answered = true
    for (const span of spansAt(project.service, kind, fileName, position)) {
      const location = toLocation(project, worktreePath, span.fileName, span.start, span.isDefinition)
      if (location) locations.push(location)
    }
  }
  if (!answered) return null
  // A symbol and its import alias report overlapping spans, keep one per position and remember if any marked it a definition
  const unique = new Map<string, CodeLocation>()
  for (const location of locations) {
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
  if (target.text !== undefined && overlays.has(fileName)) setOverlay(fileName, target.text)
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

type OpenDocument = { service: ts.LanguageService; fileName: string; sourceFile: ts.SourceFile; offset: number }

/** Applies the editor's text, then resolves the position in it */
function openDocument(worktreePath: string, path: string, text: string, position: CodePosition): OpenDocument | null {
  const fileName = resolve(worktreePath, path)
  if (!supportsLanguageService(fileName)) return null
  setOverlay(fileName, text)
  const project = projectFor(worktreePath, fileName)
  const sourceFile = project.service.getProgram()?.getSourceFile(fileName)
  const offset = positionOf(project, fileName, position)
  return sourceFile && offset !== null ? { service: project.service, fileName, sourceFile, offset } : null
}

function rangeOf(sourceFile: ts.SourceFile, start: number, length: number): CodeRange {
  const from = sourceFile.getLineAndCharacterOfPosition(start)
  const to = sourceFile.getLineAndCharacterOfPosition(start + length)
  return { start: { line: from.line + 1, column: from.character }, end: { line: to.line + 1, column: to.character } }
}

export function completions(worktreePath: string, path: string, text: string, position: CodePosition): CompletionItem[] | null {
  const document = openDocument(worktreePath, path, text, position)
  if (!document) return null
  const result = document.service.getCompletionsAtPosition(document.fileName, document.offset, PREFERENCES)
  return (result?.entries ?? []).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    sortText: entry.sortText,
    insertText: entry.insertText ?? entry.name,
    range: entry.replacementSpan ? rangeOf(document.sourceFile, entry.replacementSpan.start, entry.replacementSpan.length) : null,
    source: entry.source ?? null,
    data: entry.data ? JSON.stringify(entry.data) : null
  }))
}

/** data is what completions() serialized from TypeScript's own CompletionEntryData; narrow before trusting it back */
function isCompletionEntryData(value: unknown): value is ts.CompletionEntryData {
  return typeof value === 'object' && value !== null && 'exportName' in value && typeof (value as { exportName: unknown }).exportName === 'string'
}

export function completionDetails(worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null): CompletionDetails | null {
  const document = openDocument(worktreePath, path, text, position)
  if (!document) return null
  const parsed: unknown = data ? JSON.parse(data) : undefined
  const entryData = isCompletionEntryData(parsed) ? parsed : undefined
  const details = document.service.getCompletionEntryDetails(document.fileName, document.offset, name, {}, source ?? undefined, PREFERENCES, entryData)
  if (!details) return null
  const edits = (details.codeActions ?? [])
    .flatMap((action) => action.changes)
    .filter((change) => change.fileName === document.fileName)
    .flatMap((change) => change.textChanges)
    .map((change) => ({ range: rangeOf(document.sourceFile, change.span.start, change.span.length), text: change.newText }))
  return { detail: ts.displayPartsToString(details.displayParts), documentation: ts.displayPartsToString(details.documentation), edits }
}

export function signatureHelp(worktreePath: string, path: string, text: string, position: CodePosition): SignatureHelp | null {
  const document = openDocument(worktreePath, path, text, position)
  const help = document && document.service.getSignatureHelpItems(document.fileName, document.offset, {})
  if (!help) return null
  const parts = ts.displayPartsToString
  return {
    signatures: help.items.map((item) => {
      const parameters = item.parameters.map((parameter) => ({ label: parts(parameter.displayParts), documentation: parts(parameter.documentation) }))
      return {
        label: parts(item.prefixDisplayParts) + parameters.map((parameter) => parameter.label).join(parts(item.separatorDisplayParts)) + parts(item.suffixDisplayParts),
        documentation: parts(item.documentation),
        parameters
      }
    }),
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex
  }
}

const SEVERITY = { [ts.DiagnosticCategory.Error]: 'error', [ts.DiagnosticCategory.Warning]: 'warning', [ts.DiagnosticCategory.Suggestion]: 'info', [ts.DiagnosticCategory.Message]: 'info' } as const

export function diagnostics(worktreePath: string, path: string, text: string): CodeDiagnostic[] | null {
  const document = openDocument(worktreePath, path, text, { line: 1, column: 0 })
  if (!document) return supportsLanguageService(path) ? [] : null
  const { service, fileName, sourceFile } = document
  return [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)].flatMap((diagnostic) =>
    diagnostic.start === undefined
      ? []
      : [{ range: rangeOf(sourceFile, diagnostic.start, diagnostic.length ?? 0), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), severity: SEVERITY[diagnostic.category], code: diagnostic.code }]
  )
}

export function closeDocument(worktreePath: string, path: string): void {
  setOverlay(resolve(worktreePath, path), null)
}
