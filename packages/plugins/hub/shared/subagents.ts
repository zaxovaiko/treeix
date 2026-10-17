/** A subagent a repo defines for its coding agents, so a workflow step can run it */
export type Subagent = {
  name: string
  description: string
  model: string | null
  /** The repo it belongs to */
  folder: string
  path: string
}

const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, '').trim()

/**
 * The `key: value` pairs of a YAML frontmatter block, folded (`>-`, `|`) scalars included. One level deep, so
 * rulesync's `claudecode: { model: opus }` is read as `claudecode.model`. Not a YAML parser: the files only use this much.
 */
export function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return {}
  const fields: Record<string, string> = {}
  const lines = block[1].split(/\r?\n/)
  let parent = ''
  for (let index = 0; index < lines.length; index++) {
    const pair = /^(\s*)([\w-]+):\s*(.*)$/.exec(lines[index])
    if (!pair) continue
    const [, indent, key, rest] = pair
    if (indent) {
      if (parent && rest.trim()) fields[`${parent}.${key}`] = unquote(rest)
      continue
    }
    parent = key
    if (rest.trim() === '' || rest.trim() === '>-' || rest.trim() === '>' || rest.trim() === '|') {
      // A folded scalar, or a nested block: the indented lines below belong to this key
      const folded: string[] = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]) && !/^\s*[\w-]+:/.test(lines[index + 1])) folded.push(lines[++index].trim())
      if (folded.length) fields[key] = folded.join(' ')
      continue
    }
    fields[key] = unquote(rest)
  }
  return fields
}

/** `key = "value"` lines of a Codex agent file, up to the first multi-line block */
const toml = (text: string): Record<string, string> => {
  const fields: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const pair = /^([\w-]+)\s*=\s*"(.*)"\s*$/.exec(line)
    if (pair) fields[pair[1]] = pair[2]
  }
  return fields
}

/** What the file tells the subagent to do: the Markdown body, or a Codex file past its `key = "value"` lines */
export function subagentBody(path: string, text: string): string {
  if (path.endsWith('.toml'))
    return text
      .replace(/^[\w-]+\s*=\s*".*"\s*$/gm, '')
      .replace(/"""/g, '')
      .trim()
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/** One subagent, or null when the file names none */
export function parseSubagent(folder: string, path: string, text: string): Subagent | null {
  const file = path.split('/').pop() ?? ''
  const fields = file.endsWith('.toml') ? toml(text) : frontmatter(text)
  const name = fields.name?.trim() || file.replace(/\.(md|toml)$/, '')
  if (!name) return null
  // rulesync keeps the model under its Claude Code target
  const model = fields.model ?? fields['claudecode.model'] ?? ''
  return { name, description: (fields.description ?? '').trim(), model: model.trim() || null, folder, path }
}
