import { languageFor } from '../monaco/theme'

/** A language server: what runs, which files it takes, and how to get it when it's missing */
export interface ServerSpec {
  name: string
  command: string[]
  /** `*.ts`, or a whole file name like `Dockerfile` */
  files: string[]
  install?: string
}

export const BUILTIN: ServerSpec[] = [
  { name: 'TypeScript', command: ['typescript-language-server', '--stdio'], files: ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'], install: 'npm i -g typescript-language-server typescript' },
  { name: 'GraphQL', command: ['graphql-lsp', 'server', '-m', 'stream'], files: ['*.graphql', '*.gql'], install: 'npm i -g graphql-language-service-cli' },
  { name: 'rust-analyzer', command: ['rust-analyzer'], files: ['*.rs'], install: 'rustup component add rust-analyzer' },
  { name: 'Pyright', command: ['pyright-langserver', '--stdio'], files: ['*.py'], install: 'npm i -g pyright' },
  { name: 'gopls', command: ['gopls'], files: ['*.go'], install: 'go install golang.org/x/tools/gopls@latest' }
]

/** Per repo, relative to its root */
export const CONFIG_FILE = '.treeix/lsp.json'

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')

/** `{ "<name>": { "command": [...], "files": ["*.lua"] } }`; entries that don't fit are skipped */
export function parseConfig(text: string): ServerSpec[] {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof config !== 'object' || config === null) return []
  return Object.entries(config).flatMap(([name, entry]: [string, unknown]) => {
    if (typeof entry !== 'object' || entry === null || !('command' in entry) || !('files' in entry)) return []
    const { command, files } = entry
    return isStrings(command) && isStrings(files) ? [{ name, command, files }] : []
  })
}

/** The repo's own servers, which replace the app's of the same name */
export const withConfig = (custom: ServerSpec[]): ServerSpec[] => [...BUILTIN.filter((spec) => !custom.some((c) => c.name === spec.name)), ...custom]

const matches = (pattern: string, name: string) => (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern)

export function serversFor(path: string, specs: ServerSpec[]): ServerSpec[] {
  const name = path.split('/').pop() ?? path
  return specs.filter((spec) => spec.files.some((pattern) => matches(pattern, name)))
}

const LSP_IDS: Record<string, string> = { ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact' }

/** LSP's id for the file's language; the editor's own ids match it except for JS and TS */
export const languageId = (path: string): string => LSP_IDS[path.split('.').pop() ?? ''] ?? languageFor(path)
