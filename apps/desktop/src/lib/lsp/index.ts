import { useSyncExternalStore } from 'react'
import type { editor as MonacoEditor, IDisposable, IMarkdownString, IRange, languages } from 'monaco-editor'
import type { Api } from '../../ipc/api'
import type { Monaco } from '../monaco/setup'
import { IN_TAURI } from '../native'
import type { Rpc } from './rpc'
import { BUILTIN, CONFIG_FILE, languageId, parseConfig, serversFor, withConfig, type ServerSpec } from './servers'

// The editor as an LSP client. One server per place and spec starts with the first file it takes and stops a while after
// the last one closes; its diagnostics become markers and Problems, and it answers completion, hover and go to definition

// LSP shapes, only the fields read here
interface LspPosition {
  line: number
  character: number
}
interface LspRange {
  start: LspPosition
  end: LspPosition
}
interface LspTextEdit {
  range: LspRange
  newText: string
}
type LspDoc = string | { kind: string; value: string }
type LspMarked = string | { language: string; value: string } | { kind: string; value: string }
interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: LspDoc
  insertText?: string
  insertTextFormat?: number
  textEdit?: LspTextEdit | { newText: string; insert: LspRange; replace: LspRange }
  additionalTextEdits?: LspTextEdit[]
  sortText?: string
  filterText?: string
}
type LspDefinition = { uri: string; range: LspRange } | { targetUri: string; targetSelectionRange: LspRange }
interface Capabilities {
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean }
  hoverProvider?: unknown
  definitionProvider?: unknown
}

export type ServerState = 'starting' | 'running' | 'missing' | 'failed' | 'stopped'

export interface ServerStatus {
  key: string
  root: string
  spec: ServerSpec
  state: ServerState
  /** Name and version while running, why otherwise */
  detail: string
  /** Absolute paths it has open */
  files: string[]
}

export interface Problem {
  path: string
  /** 1-based, as Monaco counts */
  line: number
  column: number
  endLine: number
  endColumn: number
  /** LSP's: 1 error, 2 warning, 3 info, 4 hint */
  severity: number
  message: string
  source: string
}

interface Session {
  key: string
  root: string
  spec: ServerSpec
  state: ServerState
  detail: string
  /** Bumped per start and stop, so a late exit or reply from an older process is ignored */
  run: number
  /** Resolves once initialized; every message goes through it, so they keep their order */
  rpc: Promise<Rpc | null>
  docs: Map<string, { version: number; models: Map<MonacoEditor.ITextModel, IDisposable> }>
  problems: Map<string, Problem[]>
  providers: IDisposable[]
  idle?: ReturnType<typeof setTimeout>
}

const IDLE_STOP_MS = 5 * 60_000
/** LSP severity to Monaco's MarkerSeverity */
const MARKER_SEVERITY: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 }

const sessions = new Map<string, Session>()
const configs = new Map<string, Promise<ServerSpec[]>>()
let monaco: Monaco | null = null
let openDefinition: ((path: string, line: number) => void) | null = null

let snapshot: { servers: ServerStatus[]; problems: Problem[] } = { servers: [], problems: [] }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
function emit(): void {
  const all = [...sessions.values()]
  snapshot = {
    servers: all.map((s) => ({ key: s.key, root: s.root, spec: s.spec, state: s.state, detail: s.detail, files: [...s.docs.keys()] })),
    problems: all.flatMap((s) => [...s.problems.values()].flat())
  }
  listeners.forEach((listener) => listener())
}

/** Every server's status and every problem, live */
export const useLsp = (): typeof snapshot => useSyncExternalStore(subscribe, () => snapshot)

/** Where go to definition lands in another file: the Shell opens it in the file view */
export const setDefinitionOpener = (open: (path: string, line: number) => void): void => void (openDefinition = open)

/** The app's servers plus the repo's `.treeix/lsp.json`, read once per place until a restart */
export function specsFor(api: Api, root: string): Promise<ServerSpec[]> {
  let specs = configs.get(root)
  if (!specs) {
    specs = api.readFile(root, CONFIG_FILE).then(
      (text) => withConfig(text ? parseConfig(text) : []),
      () => BUILTIN
    )
    configs.set(root, specs)
  }
  return specs
}

const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))
const uriOf = (m: Monaco, path: string): string => m.Uri.file(path).toString()
const toLsp = (position: { lineNumber: number; column: number }): LspPosition => ({ line: position.lineNumber - 1, character: position.column - 1 })
const toRange = (range: LspRange): IRange => ({ startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 })
const send = (s: Session, write: (rpc: Rpc) => void) => void s.rpc.then((rpc) => rpc && write(rpc))

/** Connects an editor model to the servers for its file; `saved` after each save, `dispose` before the model's */
export function attachLsp(api: Api, m: Monaco, model: MonacoEditor.ITextModel, root: string, file: string): { saved: () => void; dispose: () => void } {
  if (!IN_TAURI) return { saved: () => {}, dispose: () => {} }
  setup(m)
  const path = `${root}/${file}`
  let live = true
  const joined: Session[] = []
  void specsFor(api, root).then((specs) => {
    if (!live) return
    for (const spec of serversFor(path, specs)) {
      const s = sessionFor(root, spec)
      openDoc(m, s, path, model)
      joined.push(s)
    }
  })
  return {
    saved: () => joined.forEach((s) => send(s, (rpc) => rpc.notify('textDocument/didSave', { textDocument: { uri: uriOf(m, path) } }))),
    dispose: () => {
      live = false
      joined.forEach((s) => closeDoc(m, s, path, model))
    }
  }
}

/** Stops and starts a server again, with `.treeix/lsp.json` read anew */
export async function restartServer(api: Api, key: string): Promise<void> {
  const s = sessions.get(key)
  if (!s || !monaco) return
  configs.delete(s.root)
  const spec = (await specsFor(api, s.root)).find((candidate) => candidate.name === s.spec.name)
  stopSession(s)
  if (spec) s.spec = spec
  start(monaco, s)
}

let ready = false
function setup(m: Monaco): void {
  monaco = m
  if (ready) return
  ready = true
  m.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selection) => {
      // The same file Monaco moves within itself
      if (!openDefinition || resource.path === source.getModel()?.uri.path) return false
      openDefinition(resource.path, !selection ? 1 : 'startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber)
      return true
    }
  })
}

function sessionFor(root: string, spec: ServerSpec): Session {
  const key = `${root}\0${spec.name}`
  let s = sessions.get(key)
  if (!s) {
    s = { key, root, spec, state: 'stopped', detail: '', run: 0, rpc: Promise.resolve(null), docs: new Map(), problems: new Map(), providers: [] }
    sessions.set(key, s)
  }
  // A missing or crashed server waits for Restart rather than retrying on every file
  if (s.state === 'stopped' && monaco) start(monaco, s)
  return s
}

function initParams(m: Monaco, root: string) {
  const uri = uriOf(m, root)
  return {
    processId: null,
    clientInfo: { name: 'Treeix' },
    rootUri: uri,
    workspaceFolders: [{ uri, name: root.split('/').pop() ?? root }],
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        publishDiagnostics: {}
      },
      workspace: { configuration: true, workspaceFolders: true }
    }
  }
}

function start(m: Monaco, s: Session): void {
  const run = ++s.run
  s.state = 'starting'
  s.detail = ''
  clearTimeout(s.idle)
  // Files open from before a restart; ones opening while it starts send their own didOpen
  const reopen = [...s.docs.keys()]
  s.rpc = (async () => {
    try {
      const { startRpc } = await import('./rpc')
      const rpc = await startRpc(
        s.root,
        s.spec.command,
        (method, params) => s.run === run && onNotify(m, s, method, params),
        (code, stderr) => s.run === run && onExit(m, s, code, stderr)
      )
      const init = await rpc.request<{ capabilities: Capabilities; serverInfo?: { name: string; version?: string } }>('initialize', initParams(m, s.root))
      if (s.run !== run) {
        void rpc.stop()
        return null
      }
      rpc.notify('initialized', {})
      s.state = 'running'
      s.detail = init.serverInfo ? [init.serverInfo.name, init.serverInfo.version].filter(Boolean).join(' ') : s.spec.command[0]
      s.providers = providers(m, s, rpc, init.capabilities)
      for (const path of reopen) {
        const doc = s.docs.get(path)
        const [model] = doc?.models.keys() ?? []
        if (doc && model) rpc.notify('textDocument/didOpen', { textDocument: { uri: uriOf(m, path), languageId: languageId(path), version: doc.version, text: model.getValue() } })
      }
      emit()
      return rpc
    } catch (reason) {
      // An exit already said why
      if (s.run === run && s.state === 'starting') {
        s.state = 'failed'
        s.detail = errorText(reason)
        emit()
      }
      return null
    }
  })()
  emit()
}

/** Its problems, markers and providers go with it */
function reset(m: Monaco, s: Session): void {
  const paths = [...s.problems.keys()]
  s.problems.clear()
  paths.forEach((path) => markers(m, s, path))
  s.providers.forEach((provider) => provider.dispose())
  s.providers = []
  s.rpc = Promise.resolve(null)
}

function stopSession(s: Session): void {
  clearTimeout(s.idle)
  s.run++
  s.state = 'stopped'
  s.detail = ''
  const rpc = s.rpc
  if (monaco) reset(monaco, s)
  emit()
  void rpc.then((running) => running?.stop())
}

function onExit(m: Monaco, s: Session, code: number | null, stderr: string): void {
  reset(m, s)
  const notInstalled = code === 127
  s.state = notInstalled ? 'missing' : 'failed'
  const lastLine = stderr.trim().split('\n').pop() ?? ''
  s.detail = notInstalled ? (s.spec.install ? `Not installed. ${s.spec.install}` : `${s.spec.command[0]} is not installed`) : lastLine || `Exited with ${code ?? 'a signal'}`
  emit()
}

const isDiagnostics = (params: unknown): params is { uri: string; diagnostics: { range: LspRange; severity?: number; message: string; source?: string }[] } =>
  typeof params === 'object' && params !== null && 'uri' in params && typeof params.uri === 'string' && 'diagnostics' in params && Array.isArray(params.diagnostics)

function onNotify(m: Monaco, s: Session, method: string, params: unknown): void {
  if (method !== 'textDocument/publishDiagnostics' || !isDiagnostics(params)) return
  const path = m.Uri.parse(params.uri).path
  const problems = params.diagnostics.map((d) => {
    const range = toRange(d.range)
    return { path, line: range.startLineNumber, column: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn, severity: d.severity ?? 1, message: d.message, source: d.source ?? s.spec.name }
  })
  if (problems.length) s.problems.set(path, problems)
  else s.problems.delete(path)
  markers(m, s, path)
  emit()
}

/** On every model of the file: the same file can be open in two panes */
function markers(m: Monaco, s: Session, path: string): void {
  const list = (s.problems.get(path) ?? []).map((p) => ({
    startLineNumber: p.line,
    startColumn: p.column,
    endLineNumber: p.endLine,
    endColumn: p.endColumn,
    message: p.message,
    source: p.source,
    severity: MARKER_SEVERITY[p.severity] ?? 8
  }))
  for (const model of m.editor.getModels()) if (model.uri.path === path) m.editor.setModelMarkers(model, s.key, list)
}

function openDoc(m: Monaco, s: Session, path: string, model: MonacoEditor.ITextModel): void {
  clearTimeout(s.idle)
  const existing = s.docs.get(path)
  const doc = existing ?? { version: 1, models: new Map() }
  s.docs.set(path, doc)
  const uri = uriOf(m, path)
  // ponytail: the whole text per change; incremental sync when big files lag
  const changes = model.onDidChangeContent(() => {
    const version = ++doc.version
    const text = model.getValue()
    send(s, (rpc) => rpc.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] }))
  })
  doc.models.set(model, changes)
  if (!existing) {
    const text = model.getValue()
    send(s, (rpc) => rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(path), version: doc.version, text } }))
  }
  markers(m, s, path)
  emit()
}

function closeDoc(m: Monaco, s: Session, path: string, model: MonacoEditor.ITextModel): void {
  const doc = s.docs.get(path)
  if (!doc) return
  doc.models.get(model)?.dispose()
  doc.models.delete(model)
  if (doc.models.size) return
  s.docs.delete(path)
  send(s, (rpc) => rpc.notify('textDocument/didClose', { textDocument: { uri: uriOf(m, path) } }))
  if (!s.docs.size && (s.state === 'running' || s.state === 'starting')) s.idle = setTimeout(() => stopSession(s), IDLE_STOP_MS)
  emit()
}

const docOf = (doc: LspDoc | undefined): string | IMarkdownString | undefined => (typeof doc === 'string' || doc === undefined ? doc : doc.kind === 'markdown' ? { value: doc.value } : doc.value)

const markdown = (part: LspMarked): IMarkdownString =>
  typeof part === 'string' ? { value: part } : 'language' in part ? { value: `\`\`\`${part.language}\n${part.value}\n\`\`\`` } : { value: part.value }

function providers(m: Monaco, s: Session, rpc: Rpc, capabilities: Capabilities): IDisposable[] {
  // Registered for every language: a provider answers only for the files its server has open
  const ours = (model: MonacoEditor.ITextModel) => s.docs.has(model.uri.path)
  const at = (model: MonacoEditor.ITextModel, position: { lineNumber: number; column: number }) => ({ textDocument: { uri: uriOf(m, model.uri.path) }, position: toLsp(position) })
  const list: IDisposable[] = []
  const completion = capabilities.completionProvider
  if (completion) {
    const K = m.languages.CompletionItemKind
    // In LSP's order, which starts at 1
    const kinds = [K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter]
    const edits = (textEdits: LspTextEdit[] | undefined) => textEdits?.map((edit) => ({ range: toRange(edit.range), text: edit.newText }))
    const original = new WeakMap<languages.CompletionItem, LspCompletionItem>()
    list.push(
      m.languages.registerCompletionItemProvider('*', {
        triggerCharacters: completion.triggerCharacters,
        provideCompletionItems: async (model, position) => {
          if (!ours(model)) return undefined
          const result = await rpc.request<LspCompletionItem[] | { isIncomplete?: boolean; items: LspCompletionItem[] } | null>('textDocument/completion', at(model, position)).catch(() => null)
          const items = Array.isArray(result) ? result : (result?.items ?? [])
          const word = model.getWordUntilPosition(position)
          const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }
          const suggestions = items.map((item) => {
            const edit = item.textEdit
            const suggestion: languages.CompletionItem = {
              label: item.label,
              kind: kinds[(item.kind ?? 1) - 1] ?? K.Text,
              detail: item.detail,
              documentation: docOf(item.documentation),
              insertText: edit?.newText ?? item.insertText ?? item.label,
              insertTextRules: item.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: !edit ? range : 'range' in edit ? toRange(edit.range) : { insert: toRange(edit.insert), replace: toRange(edit.replace) },
              sortText: item.sortText,
              filterText: item.filterText,
              additionalTextEdits: edits(item.additionalTextEdits)
            }
            original.set(suggestion, item)
            return suggestion
          })
          return { suggestions, incomplete: !Array.isArray(result) && !!result?.isIncomplete }
        },
        // Docs and auto-imports, for the highlighted item only
        resolveCompletionItem: completion.resolveProvider
          ? async (suggestion) => {
              const item = original.get(suggestion)
              const resolved = item && (await rpc.request<LspCompletionItem>('completionItem/resolve', item).catch(() => null))
              if (!resolved) return suggestion
              return { ...suggestion, detail: resolved.detail ?? suggestion.detail, documentation: docOf(resolved.documentation) ?? suggestion.documentation, additionalTextEdits: edits(resolved.additionalTextEdits) ?? suggestion.additionalTextEdits }
            }
          : undefined
      })
    )
  }
  if (capabilities.hoverProvider)
    list.push(
      m.languages.registerHoverProvider('*', {
        provideHover: async (model, position) => {
          if (!ours(model)) return undefined
          const hover = await rpc.request<{ contents: LspMarked | LspMarked[]; range?: LspRange } | null>('textDocument/hover', at(model, position)).catch(() => null)
          const contents = (hover ? (Array.isArray(hover.contents) ? hover.contents : [hover.contents]) : []).map(markdown).filter((part) => part.value)
          return contents.length ? { contents, range: hover?.range && toRange(hover.range) } : undefined
        }
      })
    )
  if (capabilities.definitionProvider)
    list.push(
      m.languages.registerDefinitionProvider('*', {
        provideDefinition: async (model, position) => {
          if (!ours(model)) return undefined
          const result = await rpc.request<LspDefinition | LspDefinition[] | null>('textDocument/definition', at(model, position)).catch(() => null)
          return (result ? (Array.isArray(result) ? result : [result]) : []).map((target) => {
            const [uri, range] = 'targetUri' in target ? [target.targetUri, target.targetSelectionRange] : [target.uri, target.range]
            const path = m.Uri.parse(uri).path
            // This model's own uri carries a per-pane query; Monaco moves within it
            return { uri: path === model.uri.path ? model.uri : m.Uri.file(path), range: toRange(range) }
          })
        }
      })
    )
  return list
}
