export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function imageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'PNG, JPEG, GIF or WebP only'
  if (file.size > MAX_IMAGE_BYTES) return 'Images up to 5 MB'
  return null
}

export type CompletionItem = { label: string; detail: string; insert: string }
export type Completion = { kind: 'command' | 'file'; query: string; start: number; items: CompletionItem[] }

export function completion(input: string, caret: number, commands: { name: string; description: string }[], files: string[]): Completion | null {
  const before = input.slice(0, caret)

  if (before.startsWith('/') && !before.includes(' ')) {
    const query = before.slice(1)
    const items = commands
      .filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()))
      .map((command) => ({ label: `/${command.name}`, detail: command.description, insert: `/${command.name} ` }))
    return { kind: 'command', query, start: 0, items }
  }

  const at = before.lastIndexOf('@')
  if (at !== -1 && (at === 0 || /\s/.test(before[at - 1] ?? '')) && !before.slice(at + 1).includes(' ')) {
    const query = before.slice(at + 1)
    const items = files
      .filter((file) => file.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
      .map((file) => ({ label: file, detail: '', insert: `@${file} ` }))
    return { kind: 'file', query, start: at, items }
  }

  return null
}

export function switchWarning(usage: { used: number } | null): { tokens: number | null } | null {
  if (usage === null) return { tokens: null }
  if (usage.used < 10000) return null
  return { tokens: usage.used }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}
