import { useSyncExternalStore } from 'react'
import type { ChatCapabilities, ChatContent, ChatEvent, ChatService, SessionStatus } from '@treeix/sdk'
import type { StartOptions, StartResult } from '../shared/types'
import { errorMessage } from '@treeix/app/ui'
import { emptyFeed, type Feed, reduce } from './feed'

export type ChatStartOptions = Parameters<ChatService['start']>[1]

export type ChatState = {
  feed: Feed
  capabilities: ChatCapabilities | null
  terminalCommand: string | null
  draft: string
  queue: ChatContent[][]
  /** Connection problem shown as a banner with Retry: a failed start or a lost connection */
  error: string | null
  connected: boolean
  /** A prompt was sent and hasn't resolved; covers the gap before its `turn_start` arrives */
  sending: boolean
  options: ChatStartOptions | null
  agentSessionId: string | null
}

export const emptyChat: ChatState = {
  feed: emptyFeed,
  capabilities: null,
  terminalCommand: null,
  draft: '',
  queue: [],
  error: null,
  connected: false,
  sending: false,
  options: null,
  agentSessionId: null
}

export function statusOf(state: ChatState): SessionStatus {
  if (state.feed.waiting) return 'input'
  if (state.feed.running || state.sending) return 'running'
  if (state.connected) return 'idle'
  return 'exited'
}

const TITLE_CHARS = 40

/** First line of a message, shortened for a tab title; null when it has no text */
export function shortTitle(text: string): string | null {
  const line = text.trim().split('\n')[0].trim()
  if (!line) return null
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line
}

/** The chat's title: its first message with text */
export function titleOf(state: ChatState): string | null {
  for (const block of state.feed.blocks) {
    const title = block.type === 'text' && block.role === 'user' ? shortTitle(block.text) : null
    if (title) return title
  }
  return null
}

export const isBusy = (state: ChatState): boolean => state.sending || state.feed.running

/** Agents don't echo live prompts, so the user's message goes into the feed here, always as its own block */
export function withUserMessage(feed: Feed, content: ChatContent[]): Feed {
  const text = content.map((item) => (item.type === 'text' ? item.text : '')).join('')
  const images = content.flatMap((item) => (item.type === 'image' ? [{ mimeType: item.mimeType, data: item.data }] : []))
  return { ...feed, blocks: [...feed.blocks, { type: 'text', role: 'user', text, images }] }
}

const beginTurn = (state: ChatState, content: ChatContent[]): ChatState => ({ ...state, sending: true, feed: withUserMessage(state.feed, content) })

/** What the prompt that just resolved leaves behind: the next queued message already started, so the chat never looks idle in between */
export function afterPrompt(state: ChatState): { state: ChatState; next: ChatContent[] | null } {
  const [next, ...rest] = state.queue
  if (!next || !state.connected) return { state: { ...state, sending: false }, next: null }
  return { state: beginTurn({ ...state, queue: rest }, next), next }
}

/** Stopping puts queued texts back into the draft, oldest first, so nothing typed is lost */
export function restoreQueue(state: ChatState): ChatState {
  if (state.queue.length === 0) return state
  const texts = state.queue.map((content) => content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join(''))
  return { ...state, queue: [], draft: [...texts, state.draft].filter(Boolean).join('\n\n') }
}

const isChatEvents = (value: unknown): value is ChatEvent[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === 'object' && item !== null && 'type' in item && typeof item.type === 'string')

type Bridge = {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
}

const chats = new Map<string, ChatState>()
const listeners = new Set<() => void>()
let bridge: Bridge | null = null

export const getChat = (chatId: string): ChatState => chats.get(chatId) ?? emptyChat

/** Worktree files for "@" completion, listed once per chat */
const fileLists = new Map<string, Promise<string[]>>()
export function filesFor(chatId: string, cwd: string): Promise<string[]> {
  let files = fileLists.get(chatId)
  if (!files) {
    files = window.api.listFiles(cwd).then(
      (listing) => listing.files,
      () => []
    )
    fileLists.set(chatId, files)
  }
  return files
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useChat = (chatId: string): ChatState => useSyncExternalStore(subscribe, () => getChat(chatId))

export const chatIds = (): string[] => [...chats.keys()]

function update(chatId: string, change: (state: ChatState) => ChatState): void {
  const current = getChat(chatId)
  const next = change(current)
  if (next === current) return
  chats.set(chatId, next)
  listeners.forEach((listener) => listener())
}

/** Attaches to the main module's events; call once when the plugin loads */
export function listen(chatBridge: Bridge): void {
  bridge = chatBridge
  // Agents from before a reload are unreachable now; chats that resume start their own
  chatBridge.send('stopAll')
  chatBridge.on('events', (chatId, events) => {
    if (typeof chatId !== 'string' || !isChatEvents(events)) return
    const now = Date.now()
    update(chatId, (state) => ({ ...state, feed: events.reduce((feed, event) => reduce(feed, event, now), state.feed) }))
    replayed(chatId)
  })
  chatBridge.on('closed', (chatId, reason) => {
    if (typeof chatId !== 'string') return
    const text = typeof reason === 'string' ? reason : 'The agent disconnected'
    update(chatId, (state) => ({ ...state, connected: false, sending: false, error: 'Disconnected', feed: reduce(state.feed, { type: 'disconnected', message: text }, Date.now()) }))
    replayed(chatId)
  })
}

export const start = (chatId: string, options: ChatStartOptions): Promise<string> => connect(chatId, options, false)

/** Resolves a fresh connect waiting for its first batch of events, which holds the replay (options always come first) */
const replayWaits = new Map<string, () => void>()
function replayed(chatId: string): void {
  replayWaits.get(chatId)?.()
  replayWaits.delete(chatId)
}

/** `fresh` empties the feed once connected, for a resumed session the agent replays, and resolves once the replay is in */
async function connect(chatId: string, options: ChatStartOptions, fresh: boolean): Promise<string> {
  if (!bridge) throw new Error('Chat is not loaded')
  update(chatId, (state) => ({ ...state, options, error: null }))
  try {
    const startOptions: StartOptions = { adapter: options.adapter, command: options.command, cwd: options.cwd, resume: options.resume }
    const result = await bridge.invoke<StartResult>('start', chatId, startOptions)
    // An older connect still waiting gives way to this one
    replayed(chatId)
    const replay = fresh ? new Promise<void>((resolve) => replayWaits.set(chatId, resolve)) : null
    update(chatId, (state) => ({
      ...state,
      feed: fresh ? emptyFeed : state.feed,
      connected: true,
      capabilities: result.capabilities,
      terminalCommand: result.terminalCommand,
      agentSessionId: result.agentSessionId
    }))
    await replay
    return result.agentSessionId
  } catch (reason) {
    update(chatId, (state) => ({ ...state, connected: false, error: errorMessage(reason) }))
    throw reason
  }
}

/** Starts again with the same agent, continuing the session it had; agents that load sessions replay it into a fresh feed */
function reconnect(chatId: string): Promise<string> {
  const { options, agentSessionId, capabilities } = getChat(chatId)
  if (!options) return Promise.reject(new Error('Nothing to reconnect'))
  return connect(chatId, { ...options, resume: agentSessionId ?? options.resume }, capabilities?.load === true)
}

export const retry = (chatId: string): void => void reconnect(chatId).catch(() => undefined)

export function stop(chatId: string): void {
  bridge?.send('stop', chatId)
  update(chatId, (state) => ({ ...state, connected: false, sending: false, queue: [], feed: { ...state.feed, running: false, waiting: false } }))
}

/** Sends a prompt whose turn `beginTurn` already started */
function prompt(chatId: string, content: ChatContent[]): void {
  if (!bridge) return
  bridge
    .invoke('prompt', chatId, content)
    .catch((reason: unknown) => update(chatId, (state) => ({ ...state, feed: reduce(state.feed, { type: 'error', message: errorMessage(reason) }, Date.now()) })))
    .finally(() => {
      const { state, next } = afterPrompt(getChat(chatId))
      update(chatId, () => state)
      if (next) prompt(chatId, next)
    })
}

/** Sends now, queues behind the running turn, or, for a chat that lost its agent, reconnects and then sends */
export function send(chatId: string, content: ChatContent[]): void {
  const chat = getChat(chatId)
  if (!chat.connected) {
    if (!chat.error || !chat.options) return
    update(chatId, (state) => ({ ...state, queue: [...state.queue, content] }))
    reconnect(chatId).then(
      () => {
        const { state, next } = afterPrompt(getChat(chatId))
        update(chatId, () => state)
        if (next) prompt(chatId, next)
      },
      () => update(chatId, restoreQueue)
    )
    return
  }
  if (isBusy(chat)) return update(chatId, (state) => ({ ...state, queue: [...state.queue, content] }))
  update(chatId, (state) => beginTurn(state, content))
  prompt(chatId, content)
}

export const unqueue = (chatId: string, index: number): void =>
  update(chatId, (state) => ({ ...state, queue: state.queue.filter((_, at) => at !== index) }))

export const setDraft = (chatId: string, draft: string): void => update(chatId, (state) => (state.draft === draft ? state : { ...state, draft }))

/** Adds text below what is already typed, a blank line between */
export const appendDraft = (chatId: string, text: string): void =>
  update(chatId, (state) => ({ ...state, draft: state.draft.trim() ? `${state.draft.trimEnd()}\n\n${text}` : text }))

/** Drops a closed chat's state and file list */
export function forget(chatId: string): void {
  fileLists.delete(chatId)
  if (!chats.delete(chatId)) return
  listeners.forEach((listener) => listener())
}

export function cancel(chatId: string): void {
  bridge?.send('cancel', chatId)
  update(chatId, restoreQueue)
}

export const answer = (chatId: string, requestId: string, optionId: string | null): void => bridge?.send('answer', chatId, requestId, optionId)

export async function setOption(chatId: string, id: string, value: string): Promise<void> {
  if (!bridge) return
  await bridge.invoke('setOption', chatId, id, value)
}

/** Resolves once the chat's turn is over, for "summarize first, then switch" */
export function whenIdle(chatId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (isBusy(getChat(chatId))) return false
      unsubscribe()
      resolve()
      return true
    }
    const unsubscribe = subscribe(() => void check())
    check()
  })
}
