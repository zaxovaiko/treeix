import { activeTheme, getSettings } from '../settings'
import { THEMES } from '../themes'
import { editorThemeColors } from './theme'

export type Monaco = typeof import('monaco-editor')

type Shiki = Awaited<ReturnType<typeof import('shiki').createHighlighter>>
type ToMonacoTheme = typeof import('@shikijs/monaco').textmateThemeToMonacoTheme
// @shikijs/monaco types its theme helper against the unlisted `monaco-editor-core` package,
// which resolves to `{}` here; assert back to the real `monaco-editor` shape we pass at runtime.
type StandaloneThemeData = Parameters<Monaco['editor']['defineTheme']>[1]
// Shiki's theme input type is readonly-strict about `@pierre/theme`'s exports; the values are
// otherwise a structural match, so the input type itself is what we cast to.
type ShikiThemeInput = NonNullable<Parameters<typeof import('shiki').createHighlighter>[0]['themes']>[number]

let loading: Promise<{ monaco: Monaco; shiki: Shiki }> | null = null
// Set once `load()` resolves, so the synchronous `applyEditorTheme` can reach them
let loadedShiki: Shiki | null = null
let toMonacoTheme: ToMonacoTheme | null = null

async function load(): Promise<{ monaco: Monaco; shiki: Shiki }> {
  const [
    monaco,
    { default: EditorWorker },
    { createHighlighter },
    { shikiToMonaco, textmateThemeToMonacoTheme },
    { default: pierreDark },
    { default: pierreLight }
  ] = await Promise.all([
    // editor.main: the whole editor, find, suggest, hover, folding and the rest
    import('monaco-editor'),
    import('monaco-editor/editor/editor.worker.js?worker'),
    import('shiki'),
    import('@shikijs/monaco'),
    import('@pierre/theme/pierre-dark'),
    import('@pierre/theme/pierre-light')
  ])
  // Only the base worker: TypeScript smarts come from the app's own language service, not Monaco's
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  // Monaco's own TypeScript mode would start its 7 MB worker and duplicate our providers; turn every feature of it off
  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false
  }
  monaco.typescript.typescriptDefaults.setModeConfiguration(off)
  monaco.typescript.javascriptDefaults.setModeConfiguration(off)
  // Their JSON, CSS and HTML modes ask the base worker for validation, folding and colors it doesn't have, which throws; shiki colors these files
  const { json, css, html } = monaco
  for (const defaults of [json.jsonDefaults, css.cssDefaults, css.scssDefaults, css.lessDefaults, html.htmlDefaults, html.handlebarDefaults, html.razorDefaults]) {
    defaults.setModeConfiguration({})
  }
  const shiki = await createHighlighter({
    themes: [pierreDark as ShikiThemeInput, pierreLight as ShikiThemeInput],
    langs: []
  })
  shikiToMonaco(shiki, monaco)
  loadedShiki = shiki
  toMonacoTheme = textmateThemeToMonacoTheme
  const { registerTypeScriptProviders } = await import('./providers')
  registerTypeScriptProviders(monaco)
  return { monaco, shiki }
}

const loaded = (): Promise<{ monaco: Monaco; shiki: Shiki }> => (loading ??= load())

export const loadMonaco = async (): Promise<Monaco> => (await loaded()).monaco

/** Grammars load on first use; shikiToMonaco re-registers tokenizers for everything loaded so far */
export async function ensureLanguage(monaco: Monaco, language: string): Promise<void> {
  const { shiki } = await loaded()
  if (language === 'text' || shiki.getLoadedLanguages().includes(language)) return
  await shiki.loadLanguage(language as Parameters<Shiki['loadLanguage']>[0]).catch(() => undefined)
  monaco.languages.register({ id: language })
  const { shikiToMonaco } = await import('@shikijs/monaco')
  shikiToMonaco(shiki, monaco)
}

/**
 * Pierre's syntax colors with the app's surface. `@shikijs/monaco` tokenizes through the active
 * shiki theme name, so the editor stays on `pierre-dark`/`pierre-light`; redefining that same
 * theme id with shiki's own token rules plus our chrome colors keeps both syntax highlighting and
 * a themed, transparent editor surface. Call after `loadMonaco()` has resolved once.
 */
export function applyEditorTheme(monaco: Monaco): void {
  const theme = THEMES[activeTheme()]
  const syntax = theme.mode === 'light' ? 'pierre-light' : 'pierre-dark'
  if (loadedShiki && toMonacoTheme) {
    const base = toMonacoTheme(loadedShiki.getTheme(syntax)) as StandaloneThemeData
    monaco.editor.defineTheme(syntax, {
      base: theme.mode === 'light' ? 'vs' : 'vs-dark',
      inherit: true,
      rules: base.rules,
      colors: { ...base.colors, ...editorThemeColors(theme, getSettings().opacity) }
    })
  }
  monaco.editor.setTheme(syntax)
}
