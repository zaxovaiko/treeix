type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const object = (value: unknown): Json => (isJson(value) ? value : {})
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const children = (node: Json): unknown[] => (Array.isArray(node.content) ? node.content : [])

export type AdfContext = {
  /** Image source for a media node; the renderer resolves these through the plugin */
  mediaSource: (attrs: Json) => string | null
  /** Called for every link, so linked Confluence pages can be listed */
  onLink?: (url: string) => void
}

const CONFLUENCE_PAGE = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/([^?#]*))?/

/** Confluence page id and title from a page URL */
export function confluencePageOf(url: string): { id: string; title: string | null } | null {
  const match = url.match(CONFLUENCE_PAGE)
  if (!match) return null
  const title = match[2] ? decodeURIComponent(match[2].replace(/\+/g, ' ')) : null
  return { id: match[1], title }
}

function linkLabel(url: string): string {
  const page = confluencePageOf(url)
  if (page) return page.title ?? `Confluence page ${page.id}`
  return url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/)?.[1] ?? url
}

function marked(node: Json, context: AdfContext): string {
  let value = text(node.text)
  // Pasted URLs often stay plain text
  for (const url of value.match(/https?:\/\/[^\s)>\]]+/g) ?? []) context.onLink?.(url)
  for (const mark of Array.isArray(node.marks) ? node.marks.filter(isJson) : []) {
    const attrs = object(mark.attrs)
    if (mark.type === 'code') value = `\`${value}\``
    else if (mark.type === 'strong') value = `**${value}**`
    else if (mark.type === 'em') value = `*${value}*`
    else if (mark.type === 'strike') value = `~~${value}~~`
    else if (mark.type === 'link' && text(attrs.href)) {
      context.onLink?.(text(attrs.href))
      value = `[${value}](${text(attrs.href)})`
    }
  }
  return value
}

const inline = (node: Json, context: AdfContext): string => children(node).map((child) => convert(child, context)).join('')
const cellText = (node: Json, context: AdfContext): string => inline(node, context).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')
const indent = (block: string, prefix: string): string =>
  block
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n')

function list(node: Json, context: AdfContext, marker: (index: number, item: Json) => string): string {
  const items = children(node)
    .filter(isJson)
    .map((item, index) => {
      const head = marker(index, item)
      const body = children(item)
        .map((child) => convert(child, context))
        .join('')
        .trim()
        // Paragraphs inside an item would otherwise split the list
        .replace(/\n{2,}/g, '\n')
      const [first = '', ...rest] = body.split('\n')
      return [`${head}${first}`, ...(rest.length ? [indent(rest.join('\n'), ' '.repeat(head.length))] : [])].join('\n')
    })
  return `${items.join('\n')}\n\n`
}

/** Mermaid from marketplace macros keeps its source in a macro parameter or the macro body */
function macroSource(node: Json): string {
  const strings: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (isJson(value)) Object.values(value).forEach(collect)
  }
  collect(object(node.attrs).parameters)
  const body = children(node)
    .map((child) => textOf(child))
    .join('\n')
  return [body, ...strings].find((candidate) => /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline)\b/.test(candidate)) ?? ''
}

const textOf = (node: unknown): string => (isJson(node) ? (node.type === 'text' ? text(node.text) : children(node).map(textOf).join(node.type === 'paragraph' ? '\n' : '')) : '')

/** Markdown from Atlassian Document Format */
export function convert(raw: unknown, context: AdfContext): string {
  if (typeof raw === 'string') return raw
  const node = object(raw)
  const attrs = object(node.attrs)
  switch (text(node.type)) {
    case 'text':
      return marked(node, context)
    case 'hardBreak':
      return '  \n'
    case 'mention':
      return `@${text(attrs.text).replace(/^@/, '')}`
    case 'emoji':
      return text(attrs.text) || text(attrs.shortName)
    case 'status':
      return `**[${text(attrs.text)}]**`
    case 'date':
      return new Date(Number(attrs.timestamp)).toISOString().slice(0, 10)
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = text(attrs.url)
      if (!url) return ''
      context.onLink?.(url)
      return node.type === 'inlineCard' ? `[${linkLabel(url)}](${url})` : `[${linkLabel(url)}](${url})\n\n`
    }
    case 'paragraph':
      return `${inline(node, context)}\n\n`
    case 'heading':
      return `${'#'.repeat(Math.min(6, Number(attrs.level) || 3))} ${inline(node, context).trim()}\n\n`
    case 'rule':
      return '---\n\n'
    case 'bulletList':
      return list(node, context, () => '- ')
    case 'orderedList':
      return list(node, context, (index) => `${(Number(attrs.order) || 1) + index}. `)
    case 'taskList':
      return list(node, context, (_, item) => (object(item.attrs).state === 'DONE' ? '- [x] ' : '- [ ] '))
    case 'codeBlock':
      return `\`\`\`${text(attrs.language)}\n${textOf(node)}\n\`\`\`\n\n`
    case 'blockquote':
    case 'panel':
      return `${indent(inline(node, context), '> ')}\n\n`
    case 'expand':
    case 'nestedExpand':
      return `${text(attrs.title) ? `**${text(attrs.title)}**\n\n` : ''}${inline(node, context)}`
    case 'table': {
      const rows = children(node).filter(isJson).map((row) => children(row).filter(isJson).map((cell) => cellText(cell, context)))
      if (rows.length === 0) return ''
      const width = Math.max(...rows.map((row) => row.length))
      const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`
      return `${[line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`
    }
    case 'media':
    case 'mediaInline': {
      const source = context.mediaSource(attrs)
      const alt = text(attrs.alt) || 'image'
      return source ? `![${alt.replace(/[[\]]/g, '')}](${source})` : ''
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return `${inline(node, context)}\n\n`
    case 'extension':
    case 'bodiedExtension':
    case 'inlineExtension': {
      if (/mermaid/i.test(text(attrs.extensionKey))) {
        const source = macroSource(node)
        return source ? `\`\`\`mermaid\n${source.trim()}\n\`\`\`\n\n` : ''
      }
      return node.type === 'bodiedExtension' ? inline(node, context) : ''
    }
    default:
      return inline(node, context)
  }
}

export const adfToMarkdown = (raw: unknown, context: AdfContext): string => convert(raw, context).replace(/\n{3,}/g, '\n\n').trim()
