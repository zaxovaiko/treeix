import { useMemo, useState } from 'react'
import { Icon } from '@treeix/app/Icon'
import type { LoggedChatEvent } from '@treeix/sdk'
import { ErrorBlock, PermissionCard, TextBlock, ThoughtBlock, ToolCard } from './Blocks'
import { type Block, emptyFeed, type PendingPermission, recomputeWaiting, reduce } from './feed'

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
    onAnswer && (
      <PermissionCard key={permission.requestId} permission={permission} newest={permission === newest} onAnswer={(optionId) => onAnswer(permission.requestId, optionId)} />
    )
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
                {block.children.length > 0 && <SubagentLog blocks={block.children} cwd={cwd} newest={newest} onAnswer={onAnswer} />}
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

/** What a subagent said and ran, folded under the call that started it */
function SubagentLog({
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
  const [open, setOpen] = useState(false)
  // A subagent asking for permission unfolds, so the card is never hidden
  const shown = open || recomputeWaiting(blocks)
  const steps = blocks.filter((block) => block.type === 'tool').length
  return (
    <div className="border-t border-border">
      <div onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-muted-foreground hover:bg-accent/50">
        <Icon name="chevron" className={`size-3 shrink-0 transition-transform ${shown ? 'rotate-90' : ''}`} />
        <span>
          Subagent · {steps} {steps === 1 ? 'step' : 'steps'}
        </span>
      </div>
      {shown && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <FeedBlocks blocks={blocks} cwd={cwd} newest={newest} onAnswer={onAnswer} />
        </div>
      )}
    </div>
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
