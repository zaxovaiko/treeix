// Monaco's editor and all its features without its languages: Shiki colors the code, and each language would
// bundle its own grammar, and TypeScript, CSS, HTML and JSON a worker of several MB
import 'monaco-editor/features/register.all'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/common/standaloneStrings'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'

export * from 'monaco-editor/editor'
