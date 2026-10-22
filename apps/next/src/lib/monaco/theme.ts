
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  sql: 'sql',
  prisma: 'prisma',
  graphql: 'graphql',
  sh: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml'
}
const BY_NAME: Record<string, string> = { dockerfile: 'docker', makefile: 'makefile' }

export function languageFor(path: string): string {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return BY_NAME[name] ?? BY_EXTENSION[extension] ?? 'text'
}

/** The app tokens the editor chrome takes, as CSS colors */
export interface Tokens {
  background: string
  popover: string
  foreground: string
  mutedForeground: string
  primary: string
}

/** Monaco only parses hex, so `#abc` widens to `#aabbcc` */
const hex = (color: string): string => color.trim().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3')

/** Overrides on top of the Pierre syntax theme so the editor sits on the app's surface */
export function editorThemeColors(tokens: Tokens): Record<string, string> {
  const [background, popover, foreground, mutedForeground, primary] = [tokens.background, tokens.popover, tokens.foreground, tokens.mutedForeground, tokens.primary].map(hex)
  return {
    'editor.background': background,
    'editorGutter.background': background,
    'minimap.background': background,
    'editorStickyScroll.background': background,
    'editorStickyScrollGutter.background': background,
    'editorWidget.background': popover,
    'editorSuggestWidget.background': popover,
    'editorHoverWidget.background': popover,
    'editorLineNumber.foreground': mutedForeground,
    'editorLineNumber.activeForeground': foreground,
    'editorCursor.foreground': foreground,
    'editor.wordHighlightBackground': `${foreground}1a`,
    'editor.wordHighlightStrongBackground': `${foreground}1a`,
    focusBorder: primary
  }
}
