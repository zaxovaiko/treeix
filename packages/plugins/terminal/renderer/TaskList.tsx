import type { Repo } from '@treeix/shared/types'
import { Icon } from '@treeix/app/Icon'
import { openMenu } from '@treeix/app/contextMenu'
import { worktreeLabel } from '@treeix/app/sessionUi'
import { usePersisted } from '@treeix/app/ui'
import { agentOr, isAgent } from '@treeix/app/agents'
import { type Activity, ActivityMark } from '@treeix/app/activity'
import { useHost, useListNav } from '@treeix/sdk'
import { type Task, taskPanes } from './tasks'
import { NameInput, renaming, startRename, switchTask, taskLabel, taskStatus } from './taskUi'
import { ClosedSessions, openTab } from './TerminalPanel'
import { type ClosedSession, clearClosedSessions, deleteTask, renameTask, type Session } from './terminals'

/** Tasks of the workspace with what their sessions need; j/k move, ⏎ goes to the task's terminal, e or double-click renames */
/** The group's pill counts the agents in its most pressing state */
const COUNTED: Partial<Record<Activity, { label: string; className: string }>> = {
  input: { label: 'waiting for you', className: 'bg-amber-400/15 text-amber-400' },
  done: { label: 'finished, not seen yet', className: 'bg-blue-400/15 text-blue-400' },
  running: { label: 'working', className: 'bg-emerald-400/10 text-emerald-400' }
}

export function TaskList({
  tasks,
  current,
  sessions,
  repos,
  onNew,
  history
}: {
  tasks: Task[]
  current: Task | null
  sessions: Session[]
  repos: Repo[] | null
  onNew: () => void
  /** Closed sessions of the group on screen */
  history: ClosedSession[]
}): React.JSX.Element {
  const host = useHost()
  const { id: renamingId } = renaming.use()
  const [historyOpen, setHistoryOpen] = usePersisted<boolean>('terminal.historyOpen', false)
  const index = tasks.findIndex((task) => task.id === current?.id)
  const { rowProps } = useListNav({ count: tasks.length, index, onSelect: (row) => switchTask(host, tasks[row]) })
  const waiting = tasks.filter((task) => taskStatus(task, sessions) === 'input').length
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Groups</span>
        {waiting > 0 && <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 text-[10.5px] text-amber-400">{waiting} waiting</span>}
        <span className="flex-1" />
        <button
          title="New group (⌘⇧T)"
          aria-label="New group"
          onClick={onNew}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="plus" className="size-3.5" />
        </button>
      </div>
      <div data-task-list tabIndex={-1} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-2 outline-none">
        {tasks.length === 0 && <p className="px-1.5 py-2 text-xs text-muted-foreground">No groups yet. ⌘⇧T starts one with a shell here.</p>}
        {tasks.map((task, row) => {
          const status = taskStatus(task, sessions)
          const panes = taskPanes(task)
          const agentsHere = sessions.filter((session) => panes.includes(session.id) && isAgent(session.kind))
          const counted = COUNTED[status]
          const count = counted ? agentsHere.filter((session) => session.status === status).length : 0
          const agents = agentsHere.length
          const firstAgent = agents > 0 ? agentOr(agentsHere[0].kind) : null
          const selected = task.id === current?.id
          const folder = worktreeLabel(repos, task.worktreePath)
          return (
            <div
              key={task.id}
              {...rowProps(row)}
              onClick={() => switchTask(host, task)}
              onDoubleClick={() => startRename(task.id)}
              onContextMenu={(event) =>
                openMenu(event, [
                  { label: 'Rename', accelerator: 'E', run: () => startRename(task.id) },
                  { label: 'New shell tab', run: () => openTab(task.worktreePath, 'shell', task.id) },
                  null,
                  { label: 'Delete group', accelerator: 'CmdOrCtrl+Backspace', run: () => deleteTask(task.id) }
                ])
              }
              className={`group/task flex min-w-0 cursor-default flex-col gap-1 rounded-md px-2 py-1.5 ${selected ? 'bg-foreground/8' : 'hover:bg-accent'}`}
            >
              {/* Fixed height, so the hover buttons don't make the row grow */}
              <div className="flex h-5 min-w-0 items-center gap-2">
                <ActivityMark activity={status} />
                {renamingId === task.id ? (
                  <NameInput
                    value={taskLabel(task, repos)}
                    label="Group name"
                    onSave={(name) => name !== task.name && renameTask(task.id, name)}
                    onDone={(input) => input.closest<HTMLElement>('[data-task-list]')?.focus()}
                  />
                ) : (
                  <>
                    <span className={`min-w-0 truncate text-xs ${selected ? 'font-medium text-foreground' : 'text-foreground/80'}`}>{taskLabel(task, repos)}</span>
                    <span className="flex-1" />
                    <span className="hidden shrink-0 items-center group-hover/task:flex">
                      <button
                        title="Rename (e, F2)"
                        aria-label="Rename group"
                        onClick={(event) => {
                          event.stopPropagation()
                          startRename(task.id)
                        }}
                        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <Icon name="pencil" className="size-3" />
                      </button>
                      <button
                        title="Delete group (⌘⌫, ⌘⇧⌫)"
                        aria-label="Delete group"
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteTask(task.id)
                        }}
                        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-red-400"
                      >
                        <Icon name="trash" className="size-3" />
                      </button>
                    </span>
                  </>
                )}
                {counted && count > 0 && (
                  <span title={`${count} ${counted.label}`} className={`shrink-0 rounded-full px-1.5 text-[10.5px] leading-4 font-medium tabular-nums ${counted.className}`}>
                    {count}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1 pl-[18px] text-muted-foreground">
                {/* An unnamed task is already titled by its folder */}
                {folder !== taskLabel(task, repos) && (
                  <>
                    <Icon name={task.worktreePath === window.api.home ? 'folder' : 'branch'} className="size-3 shrink-0" />
                    <span title={task.worktreePath} className="min-w-0 truncate font-mono text-[10.5px]">
                      {folder}
                    </span>
                  </>
                )}
                <span className="flex-1" />
                <span title={`${task.tabs.length} tabs, ${agents} agents`} className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-muted-foreground/70 tabular-nums">
                  <span className="flex items-center gap-0.5">
                    <Icon name="terminal" className="size-2.5" />
                    {task.tabs.length}
                  </span>
                  {firstAgent && (
                    <span className="flex items-center gap-0.5">
                      <span style={{ color: firstAgent.color }}>{firstAgent.mark}</span>
                      {agents}
                    </span>
                  )}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {history.length > 0 && (
        <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-border">
          <div className="group/history flex h-8 shrink-0 items-center pr-1.5">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            >
              <Icon name="chevron" className={`size-3 ${historyOpen ? 'rotate-90' : ''}`} />
              History
              <span className="font-normal normal-case tabular-nums">{history.length}</span>
            </button>
            <button
              title="Clear history"
              onClick={() =>
                window.confirm(`Remove ${history.length} closed ${history.length === 1 ? 'session' : 'sessions'} from history?`) &&
                clearClosedSessions(history.map((entry) => entry.id))
              }
              className="h-6 shrink-0 rounded px-1.5 text-[10.5px] text-muted-foreground opacity-0 group-hover/history:opacity-100 hover:text-red-400 focus-visible:opacity-100"
            >
              Clear
            </button>
          </div>
          {historyOpen && (
            <div className="min-h-0 overflow-y-auto px-1.5 pb-2">
              <ClosedSessions entries={history} repos={repos} />
            </div>
          )}
        </div>
      )}
    </>
  )
}
