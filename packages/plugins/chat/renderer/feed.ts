import type { ChatEvent, ChatOption, PermissionOption, PlanEntry, ToolCall } from '@treeix/sdk'

export type Block =
  | { type: 'text'; role: 'user' | 'agent'; text: string; images: { mimeType: string; data: string }[] }
  | { type: 'thought'; text: string; startedAt: number; endedAt: number | null }
  | { type: 'tool'; call: ToolCall; permission: PendingPermission | null }
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

function recomputeWaiting(blocks: Block[]): boolean {
  return blocks.some((block) => (block.type === 'tool' && block.permission !== null) || block.type === 'permission')
}

function clearPermission(blocks: Block[], requestId: string): Block[] {
  return blocks
    .map((block): Block | null => {
      if (block.type === 'tool' && block.permission?.requestId === requestId) return { ...block, permission: null }
      if (block.type === 'permission' && block.permission.requestId === requestId) return null
      return block
    })
    .filter((block): block is Block => block !== null)
}

export function reduce(feed: Feed, event: ChatEvent, now: number): Feed {
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
      const blocks = closeThought(feed.blocks, now)
      return { ...feed, blocks: [...blocks, { type: 'tool', call: event.call, permission: null }] }
    }
    case 'tool_call_update': {
      const blocks = feed.blocks.map((block): Block => {
        if (block.type !== 'tool' || block.call.id !== event.id) return block
        return { ...block, call: { ...block.call, ...event.patch } }
      })
      return { ...feed, blocks }
    }
    case 'permission': {
      const blocks = closeThought(feed.blocks, now)
      const permission: PendingPermission = { requestId: event.requestId, title: event.title, options: event.options }
      const targetIndex = event.toolCallId === null ? -1 : blocks.findIndex((block) => block.type === 'tool' && block.call.id === event.toolCallId)
      const nextBlocks =
        targetIndex === -1
          ? [...blocks, { type: 'permission' as const, permission }]
          : blocks.map((block, index) => (index === targetIndex && block.type === 'tool' ? { ...block, permission } : block))
      return { ...feed, blocks: nextBlocks, waiting: true }
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
      const cleared = feed.blocks.map((block): Block => (block.type === 'tool' && block.permission !== null ? { ...block, permission: null } : block))
      const withoutStandalone = cleared.filter((block) => block.type !== 'permission')
      const blocks = [...closeThought(withoutStandalone, now), { type: 'error' as const, message: event.message }]
      return { ...feed, blocks, running: false, waiting: false }
    }
  }
}

/** Lines only in the new text and only in the old one, counted as multisets; close enough for a card's +/- */
export function diffCounts(oldText: string | null, newText: string): { added: number; removed: number } {
  const remaining = new Map<string, number>()
  const oldLines = oldText === null ? [] : oldText.split('\n')
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of newText.split('\n')) {
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
