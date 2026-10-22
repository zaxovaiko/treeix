import type { ChatOption } from '@treeix/sdk'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function imageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'PNG, JPEG, GIF or WebP only'
  if (file.size > MAX_IMAGE_BYTES) return 'Images up to 5 MB'
  return null
}

/** `! command` runs in the chat's folder, as in Claude Code's bash mode */
export const shellCommandOf = (text: string): string | null => /^!\s*(\S[\s\S]*)$/.exec(text.trim())?.[1] ?? null

/** The command and its output in the tags Claude Code uses, so the agent reads it as something the user ran themselves */
export const shellPrompt = (command: string, { stdout, stderr }: { stdout: string; stderr: string }): string =>
  `<bash-input>${command}</bash-input>\n<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`

export function parseShellPrompt(text: string): { command: string; output: string } | null {
  const match = /^<bash-input>([\s\S]*?)<\/bash-input>\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>$/.exec(text.trim())
  return match
    ? {
        command: match[1],
        output: [match[2], match[3]]
          .map((part) => part.trimEnd())
          .filter(Boolean)
          .join('\n')
      }
    : null
}

/** Commands Treeix runs itself, for agents that don't offer them over ACP */
export const BUILTIN_COMMANDS = [{ name: 'clear', description: 'Start a new conversation with this agent' }]

/** The agent's own command wins over a built-in of the same name */
export const withBuiltins = (commands: { name: string; description: string }[]): { name: string; description: string }[] => [
  ...commands,
  ...BUILTIN_COMMANDS.filter((builtin) => !commands.some((command) => command.name === builtin.name))
]

/** The built-in a message runs, or null when it goes to the agent */
export function builtinOf(text: string, commands: { name: string }[]): string | null {
  const name = /^\/(\S+)$/.exec(text.trim())?.[1]
  if (!name || commands.some((command) => command.name === name)) return null
  return BUILTIN_COMMANDS.find((builtin) => builtin.name === name)?.name ?? null
}

type CompletionItem = { label: string; detail: string; insert: string }
export type Completion = { kind: 'command' | 'file'; query: string; start: number; items: CompletionItem[] }

/** The @ mention the caret is in: where its @ is and what follows it */
function mentionAt(before: string): { query: string; start: number } | null {
  const at = before.lastIndexOf('@')
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1] ?? '')) || before.slice(at + 1).includes(' ')) return null
  return { query: before.slice(at + 1), start: at }
}

/** The folder a path mention browses, like `../` or `~/projects/`, as typed; null when the mention searches the chat's own files */
export function browsedFolder(input: string, caret: number): string | null {
  const query = mentionAt(input.slice(0, caret))?.query
  return query && /^(~|\.{1,2})?\//.test(query) ? query.slice(0, query.lastIndexOf('/') + 1) : null
}

/** A browsed folder on disk: `~` is the home folder, a relative one starts in the chat's folder */
export const folderPath = (folder: string, cwd: string, home: string): string =>
  folder.startsWith('/') ? folder : folder.startsWith('~/') ? `${home}${folder.slice(1)}` : `${cwd}/${folder}`

/** `entries` are the browsed folder's, folders ending in /; picking a folder keeps the mention open to browse into it */
export function completion(input: string, caret: number, commands: { name: string; description: string }[], files: string[], entries: string[] = []): Completion | null {
  const before = input.slice(0, caret)

  if (before.startsWith('/') && !before.includes(' ')) {
    const query = before.slice(1)
    const items = commands
      .filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()))
      .map((command) => ({ label: `/${command.name}`, detail: command.description, insert: `/${command.name} ` }))
    return { kind: 'command', query, start: 0, items }
  }

  const mention = mentionAt(before)
  if (mention) {
    const { query, start } = mention
    const folder = browsedFolder(input, caret)
    if (folder !== null) {
      const name = query.slice(folder.length).toLowerCase()
      const items = entries
        .filter((entry) => entry.toLowerCase().includes(name) && (name.startsWith('.') || !entry.startsWith('.')))
        .sort((a, b) => a.localeCompare(b))
        .map((entry) => ({ label: `${folder}${entry}`, detail: '', insert: `@${folder}${entry}${entry.endsWith('/') ? '' : ' '}` }))
      return { kind: 'file', query, start, items }
    }
    const items = files
      .filter((file) => file.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
      .map((file) => ({ label: file, detail: '', insert: `@${file} ` }))
    return { kind: 'file', query, start, items }
  }

  return null
}

/** Worth a warning only once the chat holds context: usage when the agent reports it, else any message */
export function switchWarning(usage: { used: number } | null, empty: boolean): { tokens: number | null } | null {
  if (usage === null) return empty ? null : { tokens: null }
  if (usage.used < 10000) return null
  return { tokens: usage.used }
}

/** The name of an option's current value, as its picker lists it */
export const valueName = (option: ChatOption): string => option.values.find((value) => value.value === option.currentValue)?.name ?? option.currentValue

/** A Claude model id or alias as people say it: claude-haiku-4-5-20251001 is Haiku 4.5, sonnet is Sonnet */
export function modelName(id: string): string {
  const [, family = id, version = ''] = /^claude-([a-z]+)((?:-\d{1,2}){0,2})(?!\d)/.exec(id) ?? []
  if (!/^[a-z]+$/.test(family)) return id
  return `${family[0].toUpperCase()}${family.slice(1)}${version.replace('-', ' ').replaceAll('-', '.')}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

/** The draft with an @ mention of each path appended, relative to the folder when inside it */
export const withMentions = (draft: string, paths: string[], folder: string): string =>
  `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${paths.map((path) => `@${path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path} `).join('')}`
