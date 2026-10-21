import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { type ToolCall, useHost } from '@treeix/sdk'
import { agentOr, useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { useSettings } from '@treeix/app/settings'
import { worktreeLabel } from '@treeix/app/sessionUi'
import { firstAllow, firstReject, formatElapsed, useElapsed } from './Blocks'
import { Composer } from './ChatComposer'
import { FeedBlocks, pendingOf, TurnBlocks } from './Transcript'
import { findTool } from './feed'
import { activityOf, answer, cancel, type ChatState, isBusy, isConnecting, retry, useChat } from './store'
import { primaryKey, keysText } from '@treeix/shared/shortcut'

const STICK_PX = 40

function Activity({ chat }: { chat: ChatState }): React.JSX.Element {
  const seconds = useElapsed(chat.turnStartedAt, true)
  if (chat.feed.waiting) {
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-amber-300">
        <Icon name="alert" className="size-3.5 shrink-0" />
        <span>Waiting for your approval</span>
        <span className="text-muted-foreground">{keysText('⌘↵ allow · Esc deny')}</span>
      </div>
    )
  }
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
      <Icon name="loader" className="size-3.5 shrink-0 animate-spin" />
      <span className="shimmer min-w-0 truncate text-foreground/85">{activityOf(chat)}…</span>
      {chat.turnStartedAt !== null && <span className="shrink-0 tabular-nums">{formatElapsed(seconds)}</span>}
    </div>
  )
}

/** Before the first message: starting the agent, why it failed to start, or what the chat can do */
function EmptyState({ chatId, chat, cwd }: { chatId: string; chat: ChatState; cwd: string }): React.JSX.Element {
  'use no memo' // the agent is read from settings during render
  const host = useHost()
  useAgents()
  const agent = agentOr(chat.options?.agent ?? '')
  if (chat.error && !chat.connected) {
    return (
      <div className="m-auto flex max-w-md flex-col items-center gap-3 px-4 text-center text-sm">
        <Icon name="alert" className="size-6 text-red-400" />
        <div className="text-foreground">{agent.label} could not start</div>
        <div className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground select-text">{chat.error}</div>
        {chat.options && (
          <button onClick={() => retry(chatId)} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">
            Retry
          </button>
        )}
      </div>
    )
  }
  if (!chat.connected) {
    return (
      <div role="status" className="m-auto flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
        <Icon name="loader" className="size-4 animate-spin" />
        <div className="shimmer text-foreground">Starting {agent.label}…</div>
        <div className="text-xs">The first start downloads the adapter and can take a while</div>
      </div>
    )
  }
  return (
    <div className="m-auto flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
      {agent.image ? (
        <img src={agent.image} alt="" className="size-14 rounded-lg object-cover" />
      ) : (
        <span style={{ color: agent.color }} className="text-3xl">
          {agent.mark}
        </span>
      )}
      <div className="text-base text-foreground">Chat with {agent.label}</div>
      <div className="font-mono text-xs" title={cwd}>
        {worktreeLabel(host.repos, cwd)}
      </div>
    </div>
  )
}

// Space between the last message and the top of the message box (and the rows floating above it)
const FLOAT_CLEARANCE_PX = 160

/** One subagent's log, live while it runs; column-reverse keeps the scroll on its newest step */
function SubagentPane({ chatId, callId, cwd }: { chatId: string; callId: string; cwd: string }): React.JSX.Element {
  const { feed } = useChat(chatId)
  const blocks = findTool(feed.blocks, callId)?.children ?? []
  return (
    <div className="flex h-full min-h-0 flex-col-reverse overflow-x-hidden overflow-y-auto">
      <div className="flex flex-col gap-3 p-4 pr-20">
        <FeedBlocks blocks={blocks} cwd={cwd} newest={null} onAnswer={(requestId, optionId) => answer(chatId, requestId, optionId)} />
      </div>
    </div>
  )
}

export function Chat({ chatId }: { chatId: string }): React.JSX.Element {
  const host = useHost()
  const chat = useChat(chatId)
  const { chatFullWidth } = useSettings()
  const agents = useAgents()
  const { feed } = chat
  const width = chatFullWidth ? 'max-w-none' : 'max-w-3xl'
  const empty = feed.blocks.length === 0
  const cwd = chat.options?.cwd ?? host.defaultCwd
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const lastTop = useRef(0)
  const floating = useRef<HTMLDivElement>(null)

  const toBottom = (): void => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }
  useLayoutEffect(() => {
    if (atBottom.current) toBottom()
  }, [feed])
  // Diffs and markdown settle after rendering; follow their growth while at the bottom
  useEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => atBottom.current && toBottom())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // The last message stays well clear of everything floating over the bottom, however tall that grows
  useEffect(() => {
    const over = floating.current
    if (!over) return
    const observer = new ResizeObserver(() => content.current?.style.setProperty('padding-bottom', `${over.offsetHeight + FLOAT_CLEARANCE_PX}px`))
    observer.observe(over)
    return () => observer.disconnect()
  }, [])

  // Stable, so typing in the composer (which changes the draft, and so the chat) doesn't rerender the transcript
  const reply = useCallback(
    (requestId: string, optionId: string): void => {
      answer(chatId, requestId, optionId)
      root.current?.querySelector('textarea')?.focus()
    },
    [chatId]
  )

  const newest = feed.blocks.map(pendingOf).findLast((permission) => permission !== null) ?? null

  const openSubagent = useCallback(
    (call: ToolCall): void =>
      host.openTab({
        key: `subagent:${chatId}:${call.id}`,
        title: call.title,
        icon: <Icon name="sparkles" className="size-3.5" />,
        parent: 'terminal',
        content: <SubagentPane chatId={chatId} callId={call.id} cwd={cwd} />
      }),
    [host, chatId, cwd]
  )

  const onKeyDownCapture = (event: React.KeyboardEvent): void => {
    // Keys from portaled menus (option pickers) reach here through React but are not the chat's
    if (!newest || !(event.target instanceof Node && root.current?.contains(event.target))) return
    // Esc with the completion list open closes the list
    if (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.getAttribute('aria-expanded') === 'true') return
    const option = event.key === 'Enter' && primaryKey(event) ? firstAllow(newest.options) : event.key === 'Escape' ? firstReject(newest.options) : undefined
    if (!option) return
    event.preventDefault()
    event.stopPropagation()
    reply(newest.requestId, option.id)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !isBusy(chat)) return
    event.preventDefault()
    cancel(chatId)
  }

  return (
    <div
      ref={root}
      data-drop-zone
      tabIndex={-1}
      className="relative flex h-full min-h-0 flex-col bg-background outline-none"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          // Only scrolling up lets go of the end: content that grows before a jump's scroll event arrives, like images loading, keeps it
          if (element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX) atBottom.current = true
          else if (element.scrollTop < lastTop.current) atBottom.current = false
          lastTop.current = element.scrollTop
        }}
        className="@container flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
      >
        {/* A right gutter for the reply's Raw button whenever the margin beside the column can't hold it */}
        <div ref={content} className={`mx-auto flex w-full flex-1 ${width} flex-col gap-3 px-4 pt-4 ${chatFullWidth ? 'pr-20' : '@max-[57rem]:pr-20'}`}>
          {empty ? (
            <EmptyState chatId={chatId} chat={chat} cwd={cwd} />
          ) : (
            <TurnBlocks blocks={feed.blocks} cwd={cwd} newest={newest} onAnswer={reply} onOpenSubagent={openSubagent} live={feed.running} />
          )}
        </div>
      </div>
      {/* Floats over the messages, which scroll on beneath it; the rows above the box stack on one opaque column so no text shows between them */}
      <div ref={floating} className={`pointer-events-none absolute inset-x-0 bottom-0 mx-auto w-full ${width} [&>*]:pointer-events-auto`}>
        <div className="mx-2 flex flex-col gap-2 bg-background px-2 pb-2 empty:hidden">
          {!empty && isConnecting(chat) && (
            <div role="status" className="flex w-fit items-center gap-2 px-2 py-0.5 text-xs text-muted-foreground">
              <Icon name="loader" className="size-3.5 animate-spin" />
              <span className="shimmer">Reconnecting to {agents.find((candidate) => candidate.id === chat.options?.agent)?.label ?? chat.options?.agent}…</span>
            </div>
          )}
          {isBusy(chat) && (
            <div className="w-fit max-w-full px-1 py-0.5">
              <Activity chat={chat} />
            </div>
          )}
          {chat.error && !(empty && !chat.connected) && (
            <div className="flex items-center gap-2 rounded-md bg-background px-3 py-1.5 text-xs text-red-300 ring-1 ring-red-400/30">
              <Icon name="alert" className="size-3.5 shrink-0 text-red-400" />
              <span className="min-w-0 flex-1 truncate select-text" title={chat.error}>
                {chat.error}
              </span>
              {chat.options && (
                <button onClick={() => retry(chatId)} className="shrink-0 text-foreground hover:underline">
                  Retry
                </button>
              )}
            </div>
          )}
          {feed.running && feed.plan.length > 0 && (
            <ul className="flex flex-col gap-0.5 rounded-md bg-background px-3 py-2 text-xs ring-1 ring-border">
              {feed.plan.map((entry, index) => (
                <li key={index} className={`flex items-center gap-2 ${entry.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  <Icon
                    name={entry.status === 'completed' ? 'check' : entry.status === 'in_progress' ? 'loader' : 'chevron'}
                    className={`size-3 shrink-0 ${entry.status === 'in_progress' ? 'animate-spin text-foreground' : 'text-muted-foreground'}`}
                  />
                  <span className="min-w-0 truncate">{entry.content}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Composer
          chatId={chatId}
          cwd={cwd}
          onSent={() => {
            atBottom.current = true
            requestAnimationFrame(toBottom)
          }}
        />
      </div>
    </div>
  )
}
