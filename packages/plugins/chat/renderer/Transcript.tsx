import { useMemo } from 'react'
import type { LoggedChatEvent } from '@treeix/sdk'
import { ErrorBlock, PermissionCard, TextBlock, ThoughtBlock, ToolCard } from './Blocks'
import { type Block, emptyFeed, type PendingPermission, reduce } from './feed'

export const pendingOf = (block: Block): PendingPermission | null => (block.type === 'permission' ? block.permission : block.type === 'tool' ? block.permission : null)

/** A feed's blocks; `newest` is the permission keyboard answers go to */
export function FeedBlocks({
  blocks,
  cwd,
  newest,
  onAnswer
}: {
  blocks: Block[]
  cwd: string
  newest: PendingPermission | null
  onAnswer: ((requestId: string, optionId: string) => void) | undefined
}): React.JSX.Element {
  const card = (permission: PendingPermission): React.ReactNode =>
    onAnswer && <PermissionCard key={permission.requestId} permission={permission} newest={permission === newest} onAnswer={(optionId) => onAnswer(permission.requestId, optionId)} />
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <TextBlock key={index} block={block} />
          case 'thought':
            return <ThoughtBlock key={index} block={block} />
          case 'tool':
            return (
              <ToolCard key={block.call.id} call={block.call} cwd={cwd}>
                {block.permission && onAnswer && <div className="border-t border-border p-2">{card(block.permission)}</div>}
              </ToolCard>
            )
          case 'permission':
            return card(block.permission)
          case 'error':
            return <ErrorBlock key={index} message={block.message} />
        }
      })}
    </>
  )
}

export function Transcript({ events, cwd, onAnswer }: { events: LoggedChatEvent[]; cwd: string; onAnswer?: (requestId: string, optionId: string) => void }): React.JSX.Element {
  const blocks = useMemo(() => events.reduce((feed, { at, event }) => reduce(feed, event, at), emptyFeed).blocks, [events])
  return (
    <div className="flex flex-col gap-3">
      <FeedBlocks blocks={blocks} cwd={cwd} newest={null} onAnswer={onAnswer} />
    </div>
  )
}
