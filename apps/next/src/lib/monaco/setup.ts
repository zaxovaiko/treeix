import { editorThemeColors } from './theme'

export type Monaco = typeof import('monaco-editor')

type Shiki = Awaited<ReturnType<typeof import('shiki').createHighlighter>>
// @shikijs/monaco types its theme helper against the unlisted `monaco-editor-core`, which resolves to `{}` here
type StandaloneThemeData = Parameters<Monaco['editor']['defineTheme']>[1]
// Shiki's theme input type is readonly-strict about `@pierre/theme`'s exports, which otherwise match structurally
type ShikiThemeInput = NonNullable<Parameters<typeof import('shiki').createHighlighter>[0]['themes']>[number]

const SYNTAX = { dark: 'pierre-dark', light: 'pierre-light' } as const

let loading: Promise<{ monaco: Monaco; shiki: Shiki }> | null = null

/** Everything heavy loads here on first use, so the terminal never pays for the editor */
async function load(): Promise<{ monaco: Monaco; shiki: Shiki }> {
  const [monaco, { default: EditorWorker }, { default: TsWorker }, { createHighlighter }, { shikiToMonaco }, { default: pierreDark }, { default: pierreLight }] = await Promise.all([
    import('monaco-editor'),
    // Workers are bundled files served from the app's own origin: WKWebView refuses blob: workers
    import('monaco-editor/editor/editor.worker.js?worker'),
    import('monaco-editor/language/typescript/ts.worker.js?worker'),
    import('shiki'),
    import('@shikijs/monaco'),
    import('@pierre/theme/pierre-dark'),
    import('@pierre/theme/pierre-light')
  ])
  self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()) }
  // Single-file TS: syntax errors and in-file smarts, but unresolved imports would flag every line
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  }
  // Their JSON, CSS and HTML modes ask the base worker for validation it doesn't have, which throws; shiki colors these files
  const { json, css, html } = monaco
  for (const defaults of [json.jsonDefaults, css.cssDefaults, css.scssDefaults, css.lessDefaults, html.htmlDefaults, html.handlebarDefaults, html.razorDefaults]) {
    defaults.setModeConfiguration({})
  }
  const shiki = await createHighlighter({ themes: [pierreDark as ShikiThemeInput, pierreLight as ShikiThemeInput], langs: [] })
  shikiToMonaco(shiki, monaco)
  window.addEventListener('treeix-theme', () => void applyEditorTheme())
  return { monaco, shiki }
}

const loaded = (): Promise<{ monaco: Monaco; shiki: Shiki }> => (loading ??= load())

export const loadMonaco = async (): Promise<Monaco> => (await loaded()).monaco

/** Grammars load on first use; shikiToMonaco re-registers tokenizers for everything loaded so far */
export async function ensureLanguage(language: string): Promise<void> {
  const { monaco, shiki } = await loaded()
  if (language === 'text' || shiki.getLoadedLanguages().includes(language)) return
  await shiki.loadLanguage(language as Parameters<Shiki['loadLanguage']>[0]).catch(() => undefined)
  monaco.languages.register({ id: language })
  const { shikiToMonaco } = await import('@shikijs/monaco')
  shikiToMonaco(shiki, monaco)
  // shikiToMonaco switches every editor to shiki's raw theme; put ours back
  await applyEditorTheme()
}

const token = (style: CSSStyleDeclaration, name: string): string => style.getPropertyValue(name).trim()

/**
 * Pierre's syntax colors on the app's surface. @shikijs/monaco tokenizes through the active shiki theme name,
 * so the editor theme reuses that id with shiki's rules plus the app tokens read from CSS
 */
export async function applyEditorTheme(): Promise<void> {
  const { monaco, shiki } = await loaded()
  const { textmateThemeToMonacoTheme } = await import('@shikijs/monaco')
  const mode = document.documentElement.dataset.mode === 'light' ? 'light' : 'dark'
  const syntax = SYNTAX[mode]
  const style = getComputedStyle(document.documentElement)
  const base = textmateThemeToMonacoTheme(shiki.getTheme(syntax)) as StandaloneThemeData
  const tokens = {
    background: token(style, '--background'),
    popover: token(style, '--popover'),
    foreground: token(style, '--foreground'),
    mutedForeground: token(style, '--muted-foreground'),
    primary: token(style, '--primary')
  }
  monaco.editor.defineTheme(syntax, { base: mode === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: base.rules, colors: { ...base.colors, ...editorThemeColors(tokens) } })
  monaco.editor.setTheme(syntax)
}
