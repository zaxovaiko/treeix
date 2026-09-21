import { useLayoutEffect, useRef } from 'react'
import { useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { errorMessage } from '@treeix/app/ui'
import { ErrorBlock, firstAllow, firstReject, PermissionCard, TextBlock, ThoughtBlock, ToolCard } from './Blocks'
import { Composer } from './ChatComposer'
import type { Block, PendingPermission } from './feed'
import { answer, cancel, isBusy, retry, stop, useChat } from './store'

const STICK_PX = 40

const pendingOf = (block: Block): PendingPermission | null => (block.type === 'permission' ? block.permission : block.type === 'tool' ? block.permission : null)

export function Chat({ chatId }: { chatId: string }): React.JSX.Element {
  const host = useHost()
  const chat = useChat(chatId)
  const { feed } = chat
  const cwd = chat.options?.cwd ?? host.defaultCwd
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && atBottom.current) element.scrollTop = element.scrollHeight
  }, [feed])

  const newest = feed.blocks.map(pendingOf).findLast((permission) => permission !== null) ?? null

  const openInTerminal =
    chat.terminalCommand === null
      ? null
      : (): void => {
          const sessions = host.service('sessions')
          const command = chat.terminalCommand
          if (!sessions || command === null) return
          stop(chatId)
          sessions.runCommand(cwd, command).then(sessions.reveal, (reason: unknown) => host.flash(errorMessage(reason)))
        }

  const onKeyDownCapture = (event: React.KeyboardEvent): void => {
    if (!newest) return
    const option = event.key === 'Enter' && event.metaKey ? firstAllow(newest.options) : event.key === 'Escape' ? firstReject(newest.options) : undefined
    if (!option) return
    event.preventDefault()
    event.stopPropagation()
    answer(chatId, newest.requestId, option.id)
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
                <PermissionCard permission={permission} newest={permission === newest} onAnswer={(optionId) => answer(chatId, permission.requestId, optionId)} />
              </div>
            )}
          </ToolCard>
        )
      }
      case 'permission':
        return <PermissionCard key={block.permission.requestId} permission={block.permission} newest={block.permission === newest} onAnswer={(optionId) => answer(chatId, block.permission.requestId, optionId)} />
      case 'error':
        return <ErrorBlock key={index} message={block.message} onOpenTerminal={openInTerminal} />
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">{feed.blocks.map(renderBlock)}</div>
      </div>
      <div className="mx-auto w-full max-w-3xl">
        {chat.error && (
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
            {openInTerminal && (
              <button onClick={openInTerminal} className="shrink-0 text-foreground hover:underline">
                Open in terminal
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
        <Composer chatId={chatId} cwd={cwd} />
      </div>
    </div>
  )
}
