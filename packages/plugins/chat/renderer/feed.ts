import type { ChatEvent, ChatOption, PermissionOption, PlanEntry, ToolCall } from '@treeix/sdk'

export type Block =
  | { type: 'text'; role: 'user' | 'agent'; text: string; images: { mimeType: string; data: string }[] }
  | { type: 'thought'; text: string; startedAt: number; endedAt: number | null }
  /** `children` is what a subagent started by this call said and ran */
  | { type: 'tool'; call: ToolCall; permission: PendingPermission | null; children: Block[] }
  | { type: 'permission'; permission: PendingPermission }
  | { type: 'error'; message: string }

export type PendingPermission = { requestId: string; title: string; options: PermissionOption[] }

export type Feed = {
  blocks: Block[]
  plan: PlanEntry[]
  usage: { used: number; size: number } | null
  options: ChatOption[]
  commands: { name: string; description: string }[]
  running: boolean
  waiting: boolean
}

export const emptyFeed: Feed = { blocks: [], plan: [], usage: null, options: [], commands: [], running: false, waiting: false }

function closeThought(blocks: Block[], now: number): Block[] {
  const last = blocks[blocks.length - 1]
  if (!last || last.type !== 'thought' || last.endedAt !== null) return blocks
  return [...blocks.slice(0, -1), { ...last, endedAt: now }]
}

type ToolBlock = Extract<Block, { type: 'tool' }>

export function recomputeWaiting(blocks: Block[]): boolean {
  return blocks.some((block) => (block.type === 'tool' && (block.permission !== null || recomputeWaiting(block.children))) || block.type === 'permission')
}

/** Drops the matching permissions, or all of them when `requestId` is null */
function clearPermission(blocks: Block[], requestId: string | null): Block[] {
  const matches = (permission: PendingPermission | null): boolean => permission !== null && (requestId === null || permission.requestId === requestId)
  return blocks
    .map((block): Block | null => {
      if (block.type === 'tool') return { ...block, permission: matches(block.permission) ? null : block.permission, children: clearPermission(block.children, requestId) }
      if (block.type === 'permission' && matches(block.permission)) return null
      return block
    })
    .filter((block): block is Block => block !== null)
}

/** Applies `change` to the tool block with this id, however deep in subagents it sits; null when there is none */
function updateTool(blocks: Block[], id: string, change: (block: ToolBlock) => ToolBlock): Block[] | null {
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'tool') continue
    const own = block.call.id === id
    const children = own ? null : updateTool(block.children, id, change)
    const updated = own ? change(block) : children && { ...block, children }
    if (updated) return blocks.map((other, at) => (at === index ? updated : other))
  }
  return null
}

const parentOf = (event: ChatEvent): string | undefined =>
  event.type === 'message_chunk' || event.type === 'thought_chunk' || event.type === 'tool_call' ? event.parent : undefined

/** A subagent's event goes into the feed under the tool call that started it; one whose call is unknown stays top level */
export function reduce(feed: Feed, event: ChatEvent, now: number): Feed {
  const parent = parentOf(event)
  const nested = parent && updateTool(feed.blocks, parent, (tool) => ({ ...tool, children: reduceOwn({ ...emptyFeed, blocks: tool.children }, event, now).blocks }))
  return nested ? { ...feed, blocks: nested } : reduceOwn(feed, event, now)
}

function reduceOwn(feed: Feed, event: ChatEvent, now: number): Feed {
  switch (event.type) {
    case 'message_chunk': {
      const blocks = closeThought(feed.blocks, now)
      const last = blocks[blocks.length - 1]
      const images = event.content.type === 'image' ? [{ mimeType: event.content.mimeType, data: event.content.data }] : []
      const text = event.content.type === 'text' ? event.content.text : ''
      if (last && last.type === 'text' && last.role === event.role) {
        return { ...feed, blocks: [...blocks.slice(0, -1), { ...last, text: last.text + text, images: [...last.images, ...images] }] }
      }
      return { ...feed, blocks: [...blocks, { type: 'text', role: event.role, text, images }] }
    }
    case 'thought_chunk': {
      const last = feed.blocks[feed.blocks.length - 1]
      if (last && last.type === 'thought' && last.endedAt === null) {
        return { ...feed, blocks: [...feed.blocks.slice(0, -1), { ...last, text: last.text + event.text }] }
      }
      return { ...feed, blocks: [...feed.blocks, { type: 'thought', text: event.text, startedAt: now, endedAt: null }] }
    }
    case 'tool_call': {
      // Agents may resend a call with the same id: it replaces the card, keeping a permission waiting on it
      const index = feed.blocks.findIndex((block) => block.type === 'tool' && block.call.id === event.call.id)
      if (index !== -1) return { ...feed, blocks: feed.blocks.map((block, at) => (at === index && block.type === 'tool' ? { ...block, call: event.call } : block)) }
      const blocks = closeThought(feed.blocks, now)
      return { ...feed, blocks: [...blocks, { type: 'tool', call: event.call, permission: null, children: [] }] }
    }
    case 'tool_call_update':
      return { ...feed, blocks: updateTool(feed.blocks, event.id, (tool) => ({ ...tool, call: { ...tool.call, ...event.patch } })) ?? feed.blocks }
    case 'permission': {
      const blocks = closeThought(feed.blocks, now)
      const permission: PendingPermission = { requestId: event.requestId, title: event.title, options: event.options }
      const onTool = event.toolCallId === null ? null : updateTool(blocks, event.toolCallId, (tool) => ({ ...tool, permission }))
      return { ...feed, blocks: onTool ?? [...blocks, { type: 'permission', permission }], waiting: true }
    }
    case 'permission_settled': {
      const blocks = clearPermission(feed.blocks, event.requestId)
      return { ...feed, blocks, waiting: recomputeWaiting(blocks) }
    }
    case 'plan':
      return { ...feed, plan: event.entries }
    case 'usage':
      return { ...feed, usage: { used: event.used, size: event.size } }
    case 'options':
      return { ...feed, options: event.options }
    case 'commands':
      return { ...feed, commands: event.commands }
    case 'turn_start':
      return { ...feed, running: true }
    case 'turn_end':
      return { ...feed, blocks: closeThought(feed.blocks, now), running: false }
    case 'error':
      return { ...feed, blocks: [...closeThought(feed.blocks, now), { type: 'error', message: event.message }], running: false }
    case 'disconnected': {
      const blocks = [...closeThought(clearPermission(feed.blocks, null), now), { type: 'error' as const, message: event.message }]
      return { ...feed, blocks, running: false, waiting: false }
    }
  }
}

/** A user message, or an agent turn split into what it did on the way and the reply it ended with */
export type Turn = { steps: Block[]; answer: Block[] }

const endsTurn = (block: Block): boolean => block.type === 'text' || block.type === 'error'

export function turnsOf(blocks: Block[]): Turn[] {
  const turns: Turn[] = []
  let current: Block[] = []
  const close = (): void => {
    let cut = current.length
    while (cut > 0 && endsTurn(current[cut - 1])) cut--
    if (current.length) turns.push({ steps: current.slice(0, cut), answer: current.slice(cut) })
    current = []
  }
  for (const block of blocks) {
    if (block.type !== 'text' || block.role !== 'user') current.push(block)
    else {
      close()
      turns.push({ steps: [], answer: [block] })
    }
  }
  close()
  return turns
}

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

/** Lines only in the new text and only in the old one, counted as multisets; close enough for a card's +/- */
export function diffCounts(oldText: string | null, newText: string): { added: number; removed: number } {
  const remaining = new Map<string, number>()
  const oldLines = lines(oldText ?? '')
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(newText)) {
    const count = remaining.get(line) ?? 0
    if (count > 0) remaining.set(line, count - 1)
    else added++
  }
  const removed = [...remaining.values()].reduce((sum, count) => sum + count, 0)
  return { added, removed }
}

/** Where the file view opens an agent's path: relative to the chat's folder when inside it, else from the file's own folder */
export function fileTarget(cwd: string, path: string): { root: string; path: string } {
  if (!path.startsWith('/')) return { root: cwd, path }
  if (path.startsWith(`${cwd}/`)) return { root: cwd, path: path.slice(cwd.length + 1) }
  const slash = path.lastIndexOf('/')
  return { root: path.slice(0, slash) || '/', path: path.slice(slash + 1) }
}
