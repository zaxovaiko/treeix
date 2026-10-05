import type { List, PhrasingContent, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { type Json, object } from '@treeix/shared/json'
import { type AdfContext, adfBlocks, blocksMarkdown } from './adf'

type Mark = { type: string; attrs?: Json }
/** The media node an image was rendered from, by its source */
type MediaOf = (src: string) => Json | null

const DETAILS_OPEN = /^<details>\s*<summary>([\s\S]*?)<\/summary>\s*$/
const DETAILS_CLOSE = /^<\/details>\s*$/
const unescapeHtml = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function inlines(nodes: PhrasingContent[], marks: Mark[] = []): Json[] {
  const textNode = (value: string, applied: Mark[]): Json[] => (value ? [{ type: 'text', text: value, ...(applied.length ? { marks: applied } : {}) }] : [])
  return nodes.flatMap((node): Json[] => {
    switch (node.type) {
      case 'text':
        return textNode(node.value, marks)
      case 'strong':
        return inlines(node.children, [...marks, { type: 'strong' }])
      case 'emphasis':
        return inlines(node.children, [...marks, { type: 'em' }])
      case 'delete':
        return inlines(node.children, [...marks, { type: 'strike' }])
      // Code only goes with a link in ADF
      case 'inlineCode':
        return textNode(node.value, [...marks.filter((mark) => mark.type === 'link'), { type: 'code' }])
      case 'link':
        return inlines(node.children, [...marks, { type: 'link', attrs: { href: node.url } }])
      case 'break':
        return [{ type: 'hardBreak' }]
      case 'image':
        return textNode(node.alt || node.url, [...marks, { type: 'link', attrs: { href: node.url } }])
      case 'html':
        return textNode(node.value, marks)
      default:
        return 'children' in node ? inlines(node.children, marks) : []
    }
  })
}

/** An image of its own becomes media again: the one it came from, or an external one for a web address */
function mediaSingle(src: string, mediaOf: MediaOf): Json | null {
  const attrs = mediaOf(src) ?? (/^https?:\/\//.test(src) ? { type: 'external', url: src } : null)
  return attrs ? { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs }] } : null
}

function listNode(node: List, mediaOf: MediaOf): Json {
  if (node.children.some((item) => typeof item.checked === 'boolean')) {
    return {
      type: 'taskList',
      attrs: { localId: crypto.randomUUID() },
      content: node.children.map((item) => ({
        type: 'taskItem',
        attrs: { localId: crypto.randomUUID(), state: item.checked ? 'DONE' : 'TODO' },
        content: item.children.flatMap((child) => (child.type === 'paragraph' ? inlines(child.children) : []))
      }))
    }
  }
  return {
    type: node.ordered ? 'orderedList' : 'bulletList',
    ...(node.ordered ? { attrs: { order: node.start ?? 1 } } : {}),
    content: node.children.map((item) => {
      const content = blocks(item.children, mediaOf)
      return { type: 'listItem', content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph', content: [] }, ...content] }
    })
  }
}

function block(node: RootContent, mediaOf: MediaOf): Json[] {
  switch (node.type) {
    case 'paragraph': {
      const images = node.children.filter((child) => child.type === 'image')
      const loneImages = images.length > 0 && node.children.every((child) => child.type === 'image' || (child.type === 'text' && !child.value.trim()) || child.type === 'break')
      const media = loneImages ? images.map((image) => mediaSingle(image.url, mediaOf)) : []
      if (loneImages && media.every((entry) => entry !== null)) return media
      return [{ type: 'paragraph', content: inlines(node.children) }]
    }
    case 'heading':
      return [{ type: 'heading', attrs: { level: node.depth }, content: inlines(node.children) }]
    case 'thematicBreak':
      return [{ type: 'rule' }]
    case 'blockquote':
      return [{ type: 'blockquote', content: blocks(node.children, mediaOf) }]
    case 'list':
      return [listNode(node, mediaOf)]
    case 'code':
      return [{ type: 'codeBlock', attrs: node.lang ? { language: node.lang } : {}, ...(node.value ? { content: [{ type: 'text', text: node.value }] } : {}) }]
    case 'table':
      return [
        {
          type: 'table',
          content: node.children.map((row, index) => ({
            type: 'tableRow',
            content: row.children.map((cell) => ({ type: index === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: inlines(cell.children) }] }))
          }))
        }
      ]
    case 'html':
      return node.value.trim() ? [{ type: 'paragraph', content: [{ type: 'text', text: node.value }] }] : []
    default:
      return []
  }
}

/** Blocks, with the details blocks expands render as turned back into expands */
function blocks(nodes: RootContent[], mediaOf: MediaOf): Json[] {
  const frames: { title: string; content: Json[] }[] = [{ title: '', content: [] }]
  const closeFrame = (): void => {
    const frame = frames.pop()
    if (!frame) return
    const parent = frames[frames.length - 1]
    // Expands nest one level deep in ADF; anything deeper joins the one around it
    if (frames.length > 2) parent.content.push(...frame.content)
    else
      parent.content.push({
        type: frames.length === 1 ? 'expand' : 'nestedExpand',
        attrs: { title: frame.title },
        content: frame.content.length ? frame.content : [{ type: 'paragraph', content: [] }]
      })
  }
  for (const node of nodes) {
    const open = node.type === 'html' ? node.value.trim().match(DETAILS_OPEN) : null
    if (open) frames.push({ title: unescapeHtml(open[1].trim()), content: [] })
    else if (node.type === 'html' && DETAILS_CLOSE.test(node.value.trim())) {
      if (frames.length > 1) closeFrame()
    } else frames[frames.length - 1].content.push(...block(node, mediaOf))
  }
  while (frames.length > 1) closeFrame()
  return frames[0].content
}

const markdownToAdf = (markdown: string, mediaOf: MediaOf): Json[] =>
  blocks(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children, mediaOf)

/** Where a block's markdown sits in the edit as whole lines, -1 when the edit changed it */
function blockAt(edited: string, markdown: string, from: number): number {
  for (let at = edited.indexOf(markdown, from); at >= 0; at = edited.indexOf(markdown, at + 1)) {
    const end = at + markdown.length
    if ((at === 0 || edited[at - 1] === '\n') && (end === edited.length || edited[end] === '\n')) return at
  }
  return -1
}

/**
 * The document with a markdown edit applied. Blocks the edit left alone stay as they were, so macros, mentions and
 * layouts markdown can't hold survive; only the text around them is parsed anew.
 * ponytail: blocks are matched greedily in order, so deleting a block whose text repeats further down re-parses the
 * blocks in between; a block diff (LCS) would keep those too.
 */
export function editedAdf(doc: unknown, original: string, edited: string, mediaSource: AdfContext['mediaSource']): Json {
  const media = new Map<string, Json>()
  const kept = adfBlocks(doc, {
    mediaSource: (attrs) => {
      const source = mediaSource(attrs)
      if (source) media.set(source, attrs)
      return source
    }
  })
  if (blocksMarkdown(kept) !== original.trim()) throw new Error('It changed since you started editing. Copy your text, reload, and edit again.')
  const parse = (markdown: string): Json[] => (markdown.trim() ? markdownToAdf(markdown, (src) => media.get(src) ?? null) : [])
  const content: unknown[] = []
  let cursor = 0
  for (const block of kept) {
    // Blocks that show nothing, like a table of contents, can't be edited, so they stay where they were
    if (!block.markdown) {
      content.push(block.node)
      continue
    }
    const at = blockAt(edited, block.markdown, cursor)
    if (at < 0) continue
    content.push(...parse(edited.slice(cursor, at)), block.node)
    cursor = at + block.markdown.length
  }
  content.push(...parse(edited.slice(cursor)))
  return { ...object(doc), type: 'doc', version: 1, content }
}
