import type { editor, languages } from 'monaco-editor'
import type { CodePosition, CodeRange } from '../../../shared/types'
import type { Monaco } from './setup'

// Keys of monaco.languages.CompletionItemKind, read straight off the type so this can never drift
// from the real enum; `languages` is a type-only import, so this stays Monaco-free at runtime
// (providers.test.ts imports these helpers without loading Monaco).
type CompletionKindName = keyof typeof languages.CompletionItemKind

const KINDS = {
  method: 'Method',
  function: 'Function',
  'local function': 'Function',
  constructor: 'Constructor',
  property: 'Property',
  getter: 'Property',
  setter: 'Property',
  var: 'Variable',
  let: 'Variable',
  'local var': 'Variable',
  parameter: 'Variable',
  const: 'Constant',
  class: 'Class',
  'local class': 'Class',
  interface: 'Interface',
  type: 'TypeParameter',
  alias: 'Reference',
  enum: 'Enum',
  'enum member': 'EnumMember',
  module: 'Module',
  keyword: 'Keyword',
  string: 'Value',
  'primitive type': 'Keyword',
  directory: 'Folder',
  script: 'File',
  'external module name': 'Module'
} as const satisfies Record<string, CompletionKindName>

export const completionKind = (kind: string): CompletionKindName => (Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : 'Property')
export const toCodePosition = (position: { lineNumber: number; column: number }): CodePosition => ({ line: position.lineNumber, column: position.column - 1 })
export const toMonacoRange = (range: CodeRange): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } => ({
  startLineNumber: range.start.line,
  startColumn: range.start.column + 1,
  endLineNumber: range.end.line,
  endColumn: range.end.column + 1
})

/** worktree and path of an editor model, whose URI is file://<worktree>/<path> */
const documents = new Map<string, { worktreePath: string; path: string }>()
export const registerDocument = (model: editor.ITextModel, worktreePath: string, path: string): void => void documents.set(model.uri.toString(), { worktreePath, path })
export const forgetDocument = (model: editor.ITextModel): void => void documents.delete(model.uri.toString())

const LANGUAGES = ['typescript', 'tsx', 'javascript', 'jsx'] as const

type ResolvableCompletionItem = languages.CompletionItem & {
  data?: { uri: string; name: string; source: string | null; data: string | null; position: CodePosition; text: string }
}

export function registerTypeScriptProviders(monaco: Monaco): void {
  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      // '<' and '/' aren't forwarded to the TS completion request itself, so they'd only pop Monaco's global list
      triggerCharacters: ['.', '"', "'", '@'],
      provideCompletionItems: async (model, position) => {
        const document = documents.get(model.uri.toString())
        if (!document) return { suggestions: [] }
        const text = model.getValue()
        const items = await window.api.completions(document.worktreePath, document.path, text, toCodePosition(position))
        const word = model.getWordUntilPosition(position)
        const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        return {
          suggestions: items.map((item) => {
            const range = item.range ? toMonacoRange(item.range) : wordRange
            return {
              label: item.source ? { label: item.name, description: item.source } : item.name,
              kind: monaco.languages.CompletionItemKind[completionKind(item.kind)],
              sortText: item.sortText,
              insertText: item.insertText,
              // TS ranges that don't match the word under the cursor (e.g. `?.foo` replacing just `.`) need an
              // explicit filterText starting with what's already in that range, or Monaco's fuzzy match drops them
              filterText: item.range ? model.getValueInRange(range) + item.name : undefined,
              range,
              // resolveCompletionItem reads these back
              data: { uri: model.uri.toString(), name: item.name, source: item.source, data: item.data, position: toCodePosition(position), text }
            }
          })
        }
      },
      resolveCompletionItem: async (item: ResolvableCompletionItem) => {
        const document = item.data && documents.get(item.data.uri)
        if (!document || !item.data) return item
        const details = await window.api.completionDetails(document.worktreePath, document.path, item.data.text, item.data.position, item.data.name, item.data.source, item.data.data)
        if (!details) return item
        return {
          ...item,
          detail: details.detail,
          documentation: details.documentation ? { value: details.documentation } : undefined,
          // Auto-imports: the import line lands with the completion, like VS Code
          additionalTextEdits: details.edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.text }))
        }
      }
    })
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      provideSignatureHelp: async (model, position) => {
        const document = documents.get(model.uri.toString())
        const help = document && (await window.api.signatureHelp(document.worktreePath, document.path, model.getValue(), toCodePosition(position)))
        if (!help) return null
        return {
          value: {
            signatures: help.signatures.map((signature) => ({
              label: signature.label,
              documentation: signature.documentation,
              parameters: signature.parameters.map((parameter) => ({ label: parameter.label, documentation: parameter.documentation }))
            })),
            activeSignature: help.activeSignature,
            activeParameter: help.activeParameter
          },
          dispose: () => undefined
        }
      }
    })
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const document = documents.get(model.uri.toString())
        const word = model.getWordAtPosition(position)
        if (!document || !word) return null
        const info = await window.api.hover(document.worktreePath, { path: document.path, line: position.lineNumber, column: word.startColumn - 1, symbol: word.word })
        if (!info) return null
        return { contents: [{ value: `\`\`\`typescript\n${info.signature}\n\`\`\`` }, ...(info.documentation ? [{ value: info.documentation }] : [])] }
      }
    })
  }
}

const DIAGNOSTIC_DELAY_MS = 300

/** Squiggles, refreshed after typing pauses; also keeps the service's copy of the unsaved text current for hovers */
export function watchDiagnostics(monaco: Monaco, model: editor.ITextModel, worktreePath: string, path: string): { dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const severity = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info }
  const check = async (): Promise<void> => {
    const version = model.getVersionId()
    const found = await window.api.diagnostics(worktreePath, path, model.getValue())
    if (model.isDisposed() || model.getVersionId() !== version) return
    monaco.editor.setModelMarkers(
      model,
      'typescript',
      found.map((diagnostic) => ({ ...toMonacoRange(diagnostic.range), message: diagnostic.message, severity: severity[diagnostic.severity], code: String(diagnostic.code) }))
    )
  }
  void check()
  const listener = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), DIAGNOSTIC_DELAY_MS)
  })
  return { dispose: () => (clearTimeout(timer), listener.dispose()) }
}
