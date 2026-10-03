import { useEffect, useLayoutEffect, useRef } from 'react'
import { useHost } from '@treeix/sdk'
import { agentOr } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { useSettings } from '@treeix/app/settings'
import { baseName } from '@treeix/app/Sidebar'
import { ErrorBlock, firstAllow, firstReject, formatElapsed, PermissionCard, TextBlock, ThoughtBlock, ToolCard, useElapsed } from './Blocks'
import { Composer } from './ChatComposer'
import type { Block, PendingPermission } from './feed'
import { activityOf, answer, cancel, type ChatState, isBusy, isConnecting, retry, useChat } from './store'

const STICK_PX = 40

function Activity({ chat }: { chat: ChatState }): React.JSX.Element {
  const seconds = useElapsed(chat.turnStartedAt, true)
  if (chat.feed.waiting) {
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-amber-300">
        <Icon name="alert" className="size-3.5 shrink-0" />
        <span>Waiting for your approval</span>
        <span className="text-muted-foreground">⌘↵ allow · Esc deny</span>
      </div>
    )
  }
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
      <Icon name="loader" className="size-3.5 shrink-0 animate-spin text-sky-400" />
      <span className="min-w-0 truncate text-foreground/85">{activityOf(chat)}…</span>
      {chat.turnStartedAt !== null && <span className="shrink-0 tabular-nums">{formatElapsed(seconds)}</span>}
      <span className="shrink-0">· Esc to stop</span>
    </div>
  )
}

/** Before the first message: starting the agent, why it failed to start, or what the chat can do */
function EmptyState({ chatId, chat, cwd }: { chatId: string; chat: ChatState; cwd: string }): React.JSX.Element {
  const agent = agentOr(chat.options?.agent ?? '')
  if (chat.error && !chat.connected) {
    return (
      <div className="m-auto flex max-w-md flex-col items-center gap-3 px-4 text-center text-sm">
        <Icon name="alert" className="size-6 text-red-400" />
        <div className="text-foreground">{agent.label} could not start</div>
        <div className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground select-text">{chat.error}</div>
        {chat.options && (
          <button onClick={() => retry(chatId)} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
            Retry
          </button>
        )}
      </div>
    )
  }
  if (!chat.connected) {
    return (
      <div role="status" className="m-auto flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
        <Icon name="loader" className="size-5 animate-spin text-sky-400" />
        <div className="text-foreground">Starting {agent.label}…</div>
        <div className="text-xs">The first start downloads the adapter and can take a while</div>
      </div>
    )
  }
  return (
    <div className="m-auto flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
      <span style={{ color: agent.color }} className="text-3xl">
        {agent.mark}
      </span>
      <div className="text-base text-foreground">Chat with {agent.label}</div>
      <div className="font-mono text-xs" title={cwd}>
        {baseName(cwd)}
      </div>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        <li>@ adds a file · / runs a command</li>
        {chat.capabilities?.images && <li>Paste or drop images</li>}
        <li>Esc stops the agent</li>
      </ul>
    </div>
  )
}

const pendingOf = (block: Block): PendingPermission | null => (block.type === 'permission' ? block.permission : block.type === 'tool' ? block.permission : null)

export function Chat({ chatId }: { chatId: string }): React.JSX.Element {
  const host = useHost()
  const chat = useChat(chatId)
  const { chatFullWidth } = useSettings()
  const { feed } = chat
  const width = chatFullWidth ? 'max-w-none' : 'max-w-3xl'
  const empty = feed.blocks.length === 0
  const cwd = chat.options?.cwd ?? host.defaultCwd
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

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

  const reply = (requestId: string, optionId: string): void => {
    answer(chatId, requestId, optionId)
    root.current?.querySelector('textarea')?.focus()
  }

  const newest = feed.blocks.map(pendingOf).findLast((permission) => permission !== null) ?? null


  const onKeyDownCapture = (event: React.KeyboardEvent): void => {
    // Keys from portaled menus (option pickers) reach here through React but are not the chat's
    if (!newest || !(event.target instanceof Node && root.current?.contains(event.target))) return
    // Esc with the completion list open closes the list
    if (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.getAttribute('aria-expanded') === 'true') return
    const option = event.key === 'Enter' && event.metaKey ? firstAllow(newest.options) : event.key === 'Escape' ? firstReject(newest.options) : undefined
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

  const renderBlock = (block: Block, index: number): React.ReactNode => {
    switch (block.type) {
      case 'text':
        return <TextBlock key={index} block={block} />
      case 'thought':
        return <ThoughtBlock key={index} block={block} />
      case 'tool': {
        const permission = block.permission
        return (
          <ToolCard key={block.call.id} call={block.call} cwd={cwd}>
            {permission && (
              <div className="border-t border-border p-2">
                <PermissionCard permission={permission} newest={permission === newest} onAnswer={(optionId) => reply(permission.requestId, optionId)} />
              </div>
            )}
          </ToolCard>
        )
      }
      case 'permission':
        return <PermissionCard key={block.permission.requestId} permission={block.permission} newest={block.permission === newest} onAnswer={(optionId) => reply(block.permission.requestId, optionId)} />
      case 'error':
        return <ErrorBlock key={index} message={block.message} />
    }
  }

  return (
    <div ref={root} tabIndex={-1} className="flex h-full min-h-0 flex-col bg-background outline-none" onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div ref={content} className={`mx-auto flex w-full flex-1 ${width} flex-col gap-3 px-4 py-4`}>
          {empty ? <EmptyState chatId={chatId} chat={chat} cwd={cwd} /> : feed.blocks.map(renderBlock)}
        </div>
      </div>
      <div className={`mx-auto w-full ${width}`}>
        {!empty && isConnecting(chat) && (
          <div role="status" className="mx-4 mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Icon name="loader" className="size-3.5 animate-spin text-sky-400" />
            Reconnecting to {agentOr(chat.options?.agent ?? '').label}…
          </div>
        )}
        {isBusy(chat) && (
          <div className="mx-4 mb-2">
            <Activity chat={chat} />
          </div>
        )}
        {chat.error && !(empty && !chat.connected) && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-red-400/5 px-3 py-1.5 text-xs text-red-300 ring-1 ring-red-400/30">
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
          <ul className="mx-4 mb-2 flex flex-col gap-0.5 rounded-md px-3 py-2 text-xs ring-1 ring-border">
            {feed.plan.map((entry, index) => (
              <li key={index} className={`flex items-center gap-2 ${entry.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                <Icon
                  name={entry.status === 'completed' ? 'check' : entry.status === 'in_progress' ? 'loader' : 'chevron'}
                  className={`size-3 shrink-0 ${entry.status === 'in_progress' ? 'animate-spin text-sky-400' : 'text-muted-foreground'}`}
                />
                <span className="min-w-0 truncate">{entry.content}</span>
              </li>
            ))}
          </ul>
        )}
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
