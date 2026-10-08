import { Fragment, useMemo, useState } from 'react'
import { Icon } from '@treeix/app/Icon'
import type { LoggedChatEvent } from '@treeix/sdk'
import { ErrorBlock, PermissionCard, TextBlock, ThoughtBlock, ToolCard } from './Blocks'
import { type Block, emptyFeed, type PendingPermission, recomputeWaiting, reduce, turnsOf } from './feed'

export const pendingOf = (block: Block): PendingPermission | null => (block.type === 'permission' ? block.permission : block.type === 'tool' ? block.permission : null)

type FeedProps = {
  blocks: Block[]
  cwd: string
  newest: PendingPermission | null
  onAnswer: ((requestId: string, optionId: string) => void) | undefined
}

/** A feed's blocks; `newest` is the permission keyboard answers go to */
export function FeedBlocks({ blocks, cwd, newest, onAnswer }: FeedProps): React.JSX.Element {
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
function SubagentLog({ blocks, cwd, newest, onAnswer }: FeedProps): React.JSX.Element {
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

/** A finished turn's tool calls and thoughts, folded behind one row so its reply reads on its own */
function Steps(props: FeedProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // A step asking for permission unfolds, so the card is never hidden
  const shown = open || recomputeWaiting(props.blocks)
  const count = props.blocks.filter((block) => block.type === 'tool').length
  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground">
        <Icon name="chevron" className={`size-3 transition-transform ${shown ? 'rotate-90' : ''}`} />
        {count} {count === 1 ? 'step' : 'steps'}
      </button>
      {shown && <FeedBlocks {...props} />}
    </div>
  )
}

/** The feed turn by turn; every turn but the one still running folds its steps */
export function TurnBlocks({ live, ...props }: FeedProps & { live: boolean }): React.JSX.Element {
  const turns = turnsOf(props.blocks)
  return (
    <>
      {turns.map((turn, index) =>
        (live && index === turns.length - 1) || !turn.steps.some((block) => block.type === 'tool') ? (
          <FeedBlocks key={index} {...props} blocks={[...turn.steps, ...turn.answer]} />
        ) : (
          <Fragment key={index}>
            <Steps {...props} blocks={turn.steps} />
            <FeedBlocks {...props} blocks={turn.answer} />
          </Fragment>
        )
      )}
    </>
  )
}

export function Transcript({
  events,
  cwd,
  live = false,
  onAnswer
}: {
  events: LoggedChatEvent[]
  cwd: string
  live?: boolean
  onAnswer?: (requestId: string, optionId: string) => void
}): React.JSX.Element {
  const blocks = useMemo(() => events.reduce((feed, { at, event }) => reduce(feed, event, at), emptyFeed).blocks, [events])
  return (
    <div className="flex flex-col gap-3">
      <TurnBlocks blocks={blocks} cwd={cwd} newest={null} onAnswer={onAnswer} live={live} />
    </div>
  )
}
