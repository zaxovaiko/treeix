import { useSyncExternalStore } from 'react'
import type { ChatCapabilities, ChatContent, ChatEvent, ChatService, SessionStatus } from '@treeix/sdk'
import type { StartOptions, StartResult } from '../shared/types'
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

export const isBusy = (state: ChatState): boolean => state.sending || state.feed.running

/** Agents don't echo live prompts, so the user's message goes into the feed here */
export function withUserMessage(feed: Feed, content: ChatContent[], now: number): Feed {
  return content.reduce((next, item) => reduce(next, { type: 'message_chunk', role: 'user', content: item }, now), feed)
}

/** What the prompt that just resolved leaves behind: the next queued message to send, if still connected */
export function afterPrompt(state: ChatState): { state: ChatState; next: ChatContent[] | null } {
  const [next, ...rest] = state.queue
  if (!next || !state.connected) return { state: { ...state, sending: false }, next: null }
  return { state: { ...state, sending: false, queue: rest }, next }
}

type Bridge = {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
}

const chats = new Map<string, ChatState>()
const listeners = new Set<() => void>()
let bridge: Bridge | null = null

export const getChat = (chatId: string): ChatState => chats.get(chatId) ?? emptyChat

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

const message = (reason: unknown): string =>
  String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Attaches to the main module's events; call once when the plugin loads */
export function listen(chatBridge: Bridge): void {
  bridge = chatBridge
  chatBridge.on('events', (chatId, events) => {
    if (typeof chatId !== 'string' || !Array.isArray(events)) return
    const now = Date.now()
    update(chatId, (state) => ({ ...state, feed: (events as ChatEvent[]).reduce((feed, event) => reduce(feed, event, now), state.feed) }))
  })
  chatBridge.on('closed', (chatId, reason) => {
    if (typeof chatId !== 'string') return
    const text = typeof reason === 'string' ? reason : 'The agent disconnected'
    update(chatId, (state) => ({ ...state, connected: false, sending: false, error: 'Disconnected', feed: reduce(state.feed, { type: 'disconnected', message: text }, Date.now()) }))
  })
}

export async function start(chatId: string, options: ChatStartOptions): Promise<string> {
  if (!bridge) throw new Error('Chat is not loaded')
  update(chatId, (state) => ({ ...state, options, error: null }))
  try {
    const startOptions: StartOptions = { adapter: options.adapter, command: options.command, cwd: options.cwd, resume: options.resume }
    const result = await bridge.invoke<StartResult>('start', chatId, startOptions)
    update(chatId, (state) => ({
      ...state,
      connected: true,
      capabilities: result.capabilities,
      terminalCommand: result.terminalCommand,
      agentSessionId: result.agentSessionId
    }))
    return result.agentSessionId
  } catch (reason) {
    update(chatId, (state) => ({ ...state, connected: false, error: message(reason) }))
    throw reason
  }
}

/** Starts again with the same agent, continuing the session it had; agents that load sessions replay it into a fresh feed */
export function retry(chatId: string): void {
  const { options, agentSessionId, capabilities } = getChat(chatId)
  if (!options) return
  if (capabilities?.load) update(chatId, (state) => ({ ...state, feed: emptyFeed }))
  void start(chatId, { ...options, resume: agentSessionId ?? options.resume }).catch(() => undefined)
}

export function stop(chatId: string): void {
  bridge?.send('stop', chatId)
  update(chatId, (state) => ({ ...state, connected: false, sending: false, queue: [], feed: { ...state.feed, running: false, waiting: false } }))
}

function run(chatId: string, content: ChatContent[]): void {
  if (!bridge) return
  update(chatId, (state) => ({ ...state, sending: true, feed: withUserMessage(state.feed, content, Date.now()) }))
  bridge
    .invoke('prompt', chatId, content)
    .catch((reason: unknown) => update(chatId, (state) => ({ ...state, feed: reduce(state.feed, { type: 'error', message: message(reason) }, Date.now()) })))
    .finally(() => {
      const { state, next } = afterPrompt(getChat(chatId))
      update(chatId, () => state)
      if (next) run(chatId, next)
    })
}

/** Sends now, or queues behind the running turn */
export function send(chatId: string, content: ChatContent[]): void {
  if (isBusy(getChat(chatId))) update(chatId, (state) => ({ ...state, queue: [...state.queue, content] }))
  else run(chatId, content)
}

export const unqueue = (chatId: string, index: number): void =>
  update(chatId, (state) => ({ ...state, queue: state.queue.filter((_, at) => at !== index) }))

export const setDraft = (chatId: string, draft: string): void => update(chatId, (state) => (state.draft === draft ? state : { ...state, draft }))

export const cancel = (chatId: string): void => bridge?.send('cancel', chatId)

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
