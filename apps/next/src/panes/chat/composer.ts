import type { ChatCommand } from '../../ipc/api'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function imageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'PNG, JPEG, GIF or WebP only'
  if (file.size > MAX_IMAGE_BYTES) return 'Images up to 5 MB'
  return null
}

/** A `! command` Claude Code ran for the user, as its transcript keeps it */
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
export function completion(input: string, caret: number, commands: ChatCommand[], files: string[], entries: string[] = []): Completion | null {
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

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}
