import { useRef } from 'react'
import type { Repo } from '@treeix/shared/types'
import { worktreeLabel } from '@treeix/app/sessionUi'
import { definePluginSettings, type HostApi } from '@treeix/sdk'
import { aggregateStatus, type Task, taskPanes, type TaskStatus } from './tasks'
import { currentTask, selectTask, type Session } from './terminals'

export const STATUS_LABEL: Record<TaskStatus, string> = { input: 'needs input', running: 'working', idle: 'idle' }

/** The task's name, else its folder */
export const taskLabel = (task: Task, repos: Repo[] | null): string => task.name || worktreeLabel(repos, task.worktreePath)

export const taskStatus = (task: Task, sessions: Session[]): TaskStatus => {
  const panes = taskPanes(task)
  return aggregateStatus(sessions.filter((session) => panes.includes(session.id)).map((session) => session.status))
}

/** Amber dot: needs input; green ring: working; grey dot: idle */
export function StatusMark({ status }: { status: TaskStatus }): React.JSX.Element {
  return (
    <span title={STATUS_LABEL[status]} className="grid size-2.5 shrink-0 place-items-center">
      {status === 'running' ? (
        <span className="size-2.5 rounded-full border-[1.5px] border-emerald-400" />
      ) : (
        <span className={`size-2 rounded-full ${status === 'input' ? 'bg-amber-400 ring-2 ring-amber-400/25' : 'bg-foreground/25'}`} />
      )}
    </span>
  )
}

/** Shows a task the user picked, with the explorer on its folder; picking the shown task keeps a folder browsed since */
export function switchTask(host: HostApi, task: Task): void {
  if (task.id === currentTask()?.id) return
  selectTask(task.id)
  if (task.worktreePath !== host.explorerRoot) host.setBrowsedFolder(task.worktreePath === host.selectedWorktree ? null : task.worktreePath)
}

/** The task or session whose name is being edited in place */
export const renaming = definePluginSettings('terminal-rename', () => ({ id: null as string | null }))
export const startRename = (id: string): void => renaming.update({ id })

/** Edits a name in place: ⏎ or leaving saves, esc cancels; `onDone` hands focus back */
export function NameInput({ value, label, onSave, onDone }: { value: string; label: string; onSave: (name: string) => void; onDone: (input: HTMLInputElement) => void }): React.JSX.Element {
  // Unmounting may blur the input after ⏎ or esc already finished
  const finished = useRef(false)
  const done = (name: string | null): void => {
    if (finished.current) return
    finished.current = true
    renaming.update({ id: null })
    if (name !== null) onSave(name)
  }
  return (
    <input
      autoFocus
      defaultValue={value}
      aria-label={label}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => done(event.currentTarget.value.trim())}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        const input = event.currentTarget
        done(event.key === 'Enter' ? input.value.trim() : null)
        onDone(input)
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="h-5 min-w-0 flex-1 rounded bg-foreground/10 px-1 text-xs text-foreground outline-none"
    />
  )
}
