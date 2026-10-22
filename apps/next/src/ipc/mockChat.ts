import type { Api, ChatEntry, ChatEvent, ChatInfo, ChatsEvent, ToolCallPatch } from './api'

// Phase 5 chat demo (owner A4/U4): one chat mid-turn with reads, a diff and a permission request.
// A prompt gets a canned reply; answering the permission finishes the edit

type ChatApi = Pick<Api, 'chatCreate' | 'chatPrompt' | 'chatCancel' | 'chatAnswer' | 'chatSetOption' | 'chatList' | 'chatAttach' | 'chatClose' | 'onChats'>

const CWD = '/Users/me/projects/treeix/.claude/worktrees/feat+chat'
const AT = Date.UTC(2026, 9, 22, 11)
const NO_PATCH: ToolCallPatch = { title: null, kind: null, status: null, output: null, locations: null, rawInput: null }
const text = (t: string) => ({ type: 'text' as const, text: t })

const DEMO: ChatEvent[] = [
  { type: 'options', options: [
    { id: 'model', name: 'Model', category: 'model', currentValue: 'opus', values: [{ value: 'opus', name: 'Opus', description: 'Most capable' }, { value: 'sonnet', name: 'Sonnet', description: null }] },
    { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', values: [{ value: 'default', name: 'Ask', description: null }, { value: 'acceptEdits', name: 'Accept edits', description: null }, { value: 'plan', name: 'Plan', description: null }] },
  ] },
  { type: 'commands', commands: [{ name: 'review', description: 'Review the current branch' }, { name: 'compact', description: 'Summarize the conversation' }] },
  { type: 'turn_start' },
  { type: 'message_chunk', role: 'user', content: text('The quick terminal loses its cwd after a restart. Fix it.'), parent: null },
  { type: 'thought_chunk', text: 'The quick terminal is created before the ui state loads, so it starts in ~.', parent: null },
  { type: 'plan', entries: [
    { content: 'Find where the quick terminal is created', priority: 'high', status: 'completed' },
    { content: 'Pass the saved cwd', priority: 'high', status: 'in_progress' },
    { content: 'Add a test', priority: 'medium', status: 'pending' },
  ] },
  { type: 'tool_call', parent: null, call: { id: 't1', title: 'Read quick.rs', kind: 'read', status: 'completed', output: [text('pub fn create(app: &AppHandle) { ... }')], locations: [{ path: `${CWD}/apps/next/src-tauri/src/quick.rs`, line: 12 }], rawInput: { file_path: 'apps/next/src-tauri/src/quick.rs' } } },
  { type: 'tool_call', parent: null, call: { id: 't2', title: 'grep "quickShortcut"', kind: 'search', status: 'completed', output: [text('src/shell/Shell.tsx:88\nsrc/ipc/api.ts:94')], locations: [], rawInput: { pattern: 'quickShortcut' } } },
  { type: 'message_chunk', role: 'agent', content: text('The window opens before the saved state is read. I will pass the cwd in.'), parent: null },
  { type: 'tool_call', parent: null, call: { id: 't3', title: 'Edit quick.rs', kind: 'edit', status: 'pending', output: [{ type: 'diff', path: `${CWD}/apps/next/src-tauri/src/quick.rs`, oldText: 'let cwd = home_dir();\n', newText: 'let cwd = saved.cwd.unwrap_or_else(home_dir);\n' }], locations: [{ path: `${CWD}/apps/next/src-tauri/src/quick.rs`, line: 14 }], rawInput: { file_path: 'apps/next/src-tauri/src/quick.rs' } } },
  { type: 'permission', requestId: 'p1', title: 'Edit quick.rs', toolCallId: 't3', options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'always', name: 'Always allow edits', kind: 'allow_always' }, { id: 'reject', name: 'Reject', kind: 'reject_once' }] },
  { type: 'usage', used: 48_200, size: 200_000, cost: { amount: 0.84, currency: 'USD' } },
]

interface MockChat {
  info: ChatInfo
  log: ChatEntry[]
  streams: Set<(entry: ChatEntry) => void>
}

export function chatMock(): ChatApi {
  const chats = new Map<string, MockChat>()
  const listeners = new Set<(e: ChatsEvent) => void>()
  let next = 1

  const changed = (chat: MockChat) => listeners.forEach((cb) => cb({ type: 'changed', info: { ...chat.info } }))
  const push = (chat: MockChat, event: ChatEvent) => {
    const entry = { seq: chat.info.seq++, at: Date.now(), event }
    chat.log.push(entry)
    chat.streams.forEach((cb) => cb(entry))
  }
  const get = (id: string) => {
    const chat = chats.get(id)
    if (!chat) throw new Error(`no chat ${id}`)
    return chat
  }
  const add = (info: Omit<ChatInfo, 'seq'>, events: ChatEvent[]) => {
    const chat: MockChat = { info: { ...info, seq: 0 }, log: [], streams: new Set() }
    events.forEach((event) => push(chat, event))
    chat.log.forEach((entry, i) => (entry.at = info.createdAt + i * 4000))
    chats.set(info.id, chat)
    return chat
  }
  const capabilities = { images: true, load: true, list: true }

  if (new URLSearchParams(location.search).get('seed') !== 'empty')
    add({ id: 'chat1', agent: 'claude', cwd: CWD, title: 'Quick terminal keeps its cwd', status: 'needs', agentSession: '7f3c2a10-demo', capabilities, createdAt: AT }, DEMO)

  return {
    async chatCreate({ agent, cwd }) {
      const chat = add({ id: `chat-${next++}`, agent, cwd, title: 'New chat', status: 'idle', agentSession: null, capabilities, createdAt: Date.now() }, DEMO.slice(0, 2))
      changed(chat)
      return { ...chat.info }
    },
    async chatPrompt(id, content) {
      const chat = get(id)
      chat.info.status = 'running'
      changed(chat)
      push(chat, { type: 'turn_start' })
      content.forEach((c) => push(chat, { type: 'message_chunk', role: 'user', content: c, parent: null }))
      setTimeout(() => {
        if (!chats.has(id)) return
        push(chat, { type: 'message_chunk', role: 'agent', content: text('Done. Nothing else to change.'), parent: null })
        push(chat, { type: 'turn_end', stopReason: 'end_turn', usage: { input: 1200, cacheRead: 46_000, cacheWrite: 800, output: 340, thought: 0 } })
        chat.info.status = 'idle'
        changed(chat)
      }, 1200)
    },
    async chatCancel(id) {
      const chat = get(id)
      if (chat.info.status !== 'running' && chat.info.status !== 'needs') return
      push(chat, { type: 'turn_end', stopReason: 'cancelled', usage: null })
      chat.info.status = 'idle'
      changed(chat)
    },
    async chatAnswer(id, request, option) {
      const chat = get(id)
      push(chat, { type: 'permission_settled', requestId: request })
      push(chat, { type: 'tool_call_update', id: 't3', patch: { ...NO_PATCH, status: option && option !== 'reject' ? 'completed' : 'failed' } })
      push(chat, { type: 'turn_end', stopReason: 'end_turn', usage: null })
      chat.info.status = 'idle'
      changed(chat)
    },
    async chatSetOption(id, option, value) {
      const chat = get(id)
      const last = [...chat.log].reverse().find((e) => e.event.type === 'options')?.event
      if (last?.type !== 'options') throw new Error('no options')
      push(chat, { type: 'options', options: last.options.map((o) => (o.id === option ? { ...o, currentValue: value } : o)) })
    },
    chatList: async () => [...chats.values()].map((c) => ({ ...c.info })),
    async chatAttach(id, fromSeq, onEntry) {
      const chat = get(id)
      chat.log.slice(fromSeq).forEach(onEntry)
      chat.streams.add(onEntry)
      return { info: { ...chat.info }, detach: async () => void chat.streams.delete(onEntry) }
    },
    async chatClose(id) {
      if (!chats.delete(id)) return
      listeners.forEach((cb) => cb({ type: 'removed', chat: id }))
    },
    onChats(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
