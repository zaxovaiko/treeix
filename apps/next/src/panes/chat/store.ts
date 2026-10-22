import { useEffect, useSyncExternalStore } from 'react'
import type { Api, ChatContent, ChatEntry, ChatInfo, ChatOption } from '../../ipc/api'
import { parseShellPrompt } from './composer'
import { emptyFeed, type Feed, reduce } from './feed'

export type ChatImage = Extract<ChatContent, { type: 'image' }>

export type ChatState = {
  /** As ptyd last reported it; null until the first attach or `onChats` change */
  info: ChatInfo | null
  feed: Feed
  /** The seq the next entry gets, where a re-attach replays from */
  seq: number
  draft: string
  /** Attached to the draft, so they stay when the pane goes away */
  images: ChatImage[]
  queue: ChatContent[][]
  /** A prompt was sent and its `turn_start` hasn't arrived yet */
  sending: boolean
  /** Why the last attach or prompt failed, shown as a banner */
  error: string | null
}

export const emptyChat: ChatState = { info: null, feed: emptyFeed, seq: 0, draft: '', images: [], queue: [], sending: false, error: null }

export const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))

const TITLE_CHARS = 40

/** First line of a message, shortened for a tab title; null when it has no text */
export function shortTitle(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (!line) return null
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line
}

/** The agent's own title once it made one, else the first message with text, else ptyd's */
export function titleOf(state: ChatState): string {
  if (state.feed.title) return shortTitle(state.feed.title) ?? state.feed.title
  for (const block of state.feed.blocks) {
    const title = block.type === 'text' && block.role === 'user' ? shortTitle(parseShellPrompt(block.text)?.command ?? block.text) : null
    if (title) return title
  }
  return state.info?.title || 'New chat'
}

export const isBusy = (state: ChatState): boolean => state.sending || state.feed.running

/** What the agent is doing now, from the newest block */
export function activityOf(state: ChatState): string {
  const last = state.feed.blocks.at(-1)
  if (!state.feed.running) return 'Sending'
  if (last?.type === 'thought' && last.endedAt === null) return 'Thinking'
  if (last?.type === 'tool' && last.call.status !== 'completed' && last.call.status !== 'failed') return last.call.title || 'Running a tool'
  if (last?.type === 'text' && last.role === 'agent') return 'Writing'
  return 'Working'
}

/** Entries from a replay or the live stream; ones already applied (a re-attach overlapping) are skipped */
export function applyEntries(state: ChatState, entries: ChatEntry[]): ChatState {
  let { feed, seq, sending } = state
  for (const { seq: at, at: time, event } of entries) {
    if (at < seq) continue
    feed = reduce(feed, event, time)
    seq = at + 1
    if (event.type === 'turn_start' || event.type === 'error' || event.type === 'disconnected') sending = false
  }
  return feed === state.feed ? state : { ...state, feed, seq, sending }
}

/** The queued message to send now: the chat is attached, between turns and has its agent */
export function nextQueued(state: ChatState): ChatContent[] | null {
  const status = state.info?.status
  if (isBusy(state) || state.feed.waiting || status === 'starting' || status === 'disconnected') return null
  return state.queue[0] ?? null
}

/** Stopping puts queued texts back into the draft, oldest first, so nothing typed is lost */
export function restoreQueue(state: ChatState): ChatState {
  if (state.queue.length === 0) return state
  const texts = state.queue.map((content) => content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join(''))
  return { ...state, queue: [], draft: [...texts, state.draft].filter(Boolean).join('\n\n') }
}

// Store

let api: Api | null = null
const chats = new Map<string, ChatState>()
const listeners = new Set<() => void>()
/** Bumped on every change, so the shell re-renders chat tab titles and icons */
let version = 0
const notify = () => {
  version++
  listeners.forEach((listener) => listener())
}
/** Live attachments, one per chat however many panes show it */
const attached = new Map<string, { views: number; detach: (() => Promise<void>) | null; ready: boolean }>()

export const getChat = (id: string): ChatState => chats.get(id) ?? emptyChat

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function update(id: string, change: (state: ChatState) => ChatState): void {
  const current = getChat(id)
  const next = change(current)
  if (next === current) return
  chats.set(id, next)
  if (next.queue !== current.queue) saveQueue(id, next.queue)
  notify()
}

/** Sends the next queued message once the chat is free for it */
function drain(id: string): void {
  if (!attached.get(id)?.ready) return
  const next = nextQueued(getChat(id))
  if (!next) return
  update(id, (state) => ({ ...state, queue: state.queue.slice(1) }))
  prompt(id, next)
}

/** Starts keeping chat state in sync with ptyd; once per app */
export function initChats(chatApi: Api): void {
  if (api) return
  api = chatApi
  for (const [id, queue] of Object.entries(storedQueues())) update(id, (state) => ({ ...state, queue }))
  const changed = (info: ChatInfo) => {
    update(info.id, (state) => ({ ...state, info, sending: state.sending && info.status !== 'disconnected' }))
    drain(info.id)
  }
  chatApi.onChats((event) => {
    if (event.type === 'changed') changed(event.info)
    else forget(event.chat)
  })
  void chatApi.chatList().then((list) => list.forEach(changed), () => undefined)
}

/** Replays what the chat logged since this window last saw it, then follows it live */
function attach(id: string): void {
  if (!api) return
  const entry = attached.get(id)
  if (!entry) return
  let pending: ChatEntry[] = []
  const flush = () => {
    const entries = pending
    pending = []
    update(id, (state) => applyEntries(state, entries))
    drain(id)
  }
  api.chatAttach(id, getChat(id).seq, (logged) => {
    // A replay comes as a burst; one store update per task keeps it cheap
    if (pending.push(logged) === 1) queueMicrotask(flush)
  }).then(
    ({ info, detach }) => {
      if (attached.get(id) !== entry) return void detach()
      entry.detach = detach
      entry.ready = true
      update(id, (state) => ({ ...state, info, error: null }))
      drain(id)
    },
    (reason: unknown) => update(id, (state) => ({ ...state, error: errorText(reason) })),
  )
}

/** Keeps the chat attached until the returned release; views share one attachment */
export function retain(id: string): () => void {
  const entry = attached.get(id) ?? { views: 0, detach: null, ready: false }
  entry.views++
  if (entry.views === 1) {
    attached.set(id, entry)
    attach(id)
  }
  return () => {
    if (--entry.views > 0) return
    attached.delete(id)
    void entry.detach?.()
  }
}

/** Keeps the chat attached while a pane shows it; re-mounting (a daemon reconnect) attaches again from the last seq */
export function useChat(id: string): ChatState {
  useEffect(() => retain(id), [id])
  return useSyncExternalStore(subscribe, () => getChat(id))
}

/** For tab titles and other places that only read a chat */
export const useChatState = (id: string): ChatState => useSyncExternalStore(subscribe, () => getChat(id))
export const useChatsVersion = (): number => useSyncExternalStore(subscribe, () => version)

/** Retries a failed attach */
export function retry(id: string): void {
  update(id, (state) => ({ ...state, error: null }))
  if (attached.get(id) && !attached.get(id)?.ready) attach(id)
}

/** A prompt the agent refused goes back into the composer with what was queued behind it */
function refused(state: ChatState, content: ChatContent[], reason: unknown): ChatState {
  const images = content.filter((item): item is ChatImage => item.type === 'image')
  const text = content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('')
  const restored = restoreQueue({ ...state, queue: [...(text ? [[{ type: 'text' as const, text }]] : []), ...state.queue] })
  return { ...restored, sending: false, error: errorText(reason), images: [...images, ...state.images] }
}

function prompt(id: string, content: ChatContent[]): void {
  update(id, (state) => ({ ...state, sending: true, error: null }))
  api?.chatPrompt(id, content).catch((reason: unknown) => update(id, (state) => refused(state, content, reason)))
}

/** Sends now, or queues behind the running turn; a disconnected chat starts its agent again on send */
export function send(id: string, content: ChatContent[]): void {
  const state = getChat(id)
  if (!isBusy(state) && !state.feed.waiting && !state.queue.length) return prompt(id, content)
  update(id, (current) => ({ ...current, queue: [...current.queue, content] }))
  drain(id)
}

export function cancel(id: string): void {
  void api?.chatCancel(id).catch((reason: unknown) => update(id, (state) => ({ ...state, error: errorText(reason) })))
  update(id, (state) => restoreQueue({ ...state, sending: false }))
}

export const answer = (id: string, request: string, option: string | null): void =>
  void api?.chatAnswer(id, request, option).catch((reason: unknown) => update(id, (state) => ({ ...state, error: errorText(reason) })))

export const setOption = (id: string, option: ChatOption, value: string): void =>
  void api?.chatSetOption(id, option.id, value).catch((reason: unknown) => update(id, (state) => ({ ...state, error: errorText(reason) })))

export const unqueue = (id: string, index: number): void => update(id, (state) => ({ ...state, queue: state.queue.filter((_, at) => at !== index) }))

export const setDraft = (id: string, draft: string): void => update(id, (state) => (state.draft === draft ? state : { ...state, draft }))

export const setImages = (id: string, images: ChatImage[]): void => update(id, (state) => ({ ...state, images }))

export const dismissError = (id: string): void => update(id, (state) => ({ ...state, error: null }))

/** Drops a closed chat's state and its kept queue */
export function forget(id: string): void {
  saveQueue(id, [])
  if (chats.delete(id)) notify()
}

/** Worktree files for @ completion, listed once per folder */
const fileLists = new Map<string, Promise<string[]>>()
export function filesFor(cwd: string): Promise<string[]> {
  let files = fileLists.get(cwd)
  if (!files) {
    files = api?.listFiles(cwd).then((listing) => listing?.files ?? [], () => []) ?? Promise.resolve([])
    fileLists.set(cwd, files)
  }
  return files
}

export const listFolder = (path: string): Promise<string[]> => api?.listDirectory(path, '').catch(() => []) ?? Promise.resolve([])

// Queued messages outlive the app: kept by chat, put back on load and sent once their chat is free

const QUEUES_KEY = 'chat.queues'

const isContent = (value: unknown): value is ChatContent => {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  if (value.type === 'text') return 'text' in value && typeof value.text === 'string'
  return value.type === 'image' && 'mimeType' in value && typeof value.mimeType === 'string' && 'data' in value && typeof value.data === 'string'
}

const isQueue = (value: unknown): value is ChatContent[][] => Array.isArray(value) && value.every((content) => Array.isArray(content) && content.every(isContent))

export function storedQueues(): Record<string, ChatContent[][]> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(QUEUES_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(Object.entries(stored).filter((pair): pair is [string, ChatContent[][]] => isQueue(pair[1])))
  } catch {
    return {}
  }
}

function saveQueue(id: string, queue: ChatContent[][]): void {
  const { [id]: _, ...others } = storedQueues()
  const all = queue.length ? { ...others, [id]: queue } : others
  // Images can fill the storage; then at least the texts are kept
  const texts = Object.fromEntries(Object.entries(all).map(([chat, messages]) => [chat, messages.map((content) => content.filter((item) => item.type === 'text')).filter((content) => content.length)]))
  for (const kept of [all, texts]) {
    try {
      localStorage.setItem(QUEUES_KEY, JSON.stringify(kept))
      return
    } catch {
      // Full: try the smaller one
    }
  }
}
