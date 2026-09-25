import type { Theme } from '../themes'

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

const CLEAR = '#00000000'

/** Overrides on top of the Pierre syntax theme so the editor sits on the app's surface */
export function editorThemeColors(theme: Theme, opacity: number): Record<string, string> {
  const background = opacity < 100 ? CLEAR : theme.background
  return {
    'editor.background': background,
    'editorGutter.background': background,
    'minimap.background': background,
    'editorWidget.background': theme.popover,
    'editorSuggestWidget.background': theme.popover,
    'editorHoverWidget.background': theme.popover,
    'editorLineNumber.foreground': theme.mutedForeground,
    'editorCursor.foreground': theme.foreground,
    focusBorder: theme.primary
  }
}
