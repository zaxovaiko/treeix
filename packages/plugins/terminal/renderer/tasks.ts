import type { SessionStatus } from '@treeix/sdk'
import { type DropEdge, MAX_PANES, neighborPane, type PaneLayout, placePane, remapPanes, removePane } from './paneLayout'

/** A tab of a task: terminals split in columns, and the one last focused */
export type TerminalTab = { id: string; layout: PaneLayout; focus: string }

/** A named group of terminal tabs in a workspace */
export type Task = {
  id: string
  /** Empty for tasks made from sessions; the folder's label shows instead */
  name: string
  workspaceId: string
  /** Where new terminals of the task start: the folder it was created in */
  worktreePath: string
  tabs: TerminalTab[]
  activeTab: string | null
}

export type TaskStatus = 'input' | 'running' | 'idle'

export const tabPanes = (tab: TerminalTab): string[] => tab.layout.flat()
export const taskPanes = (task: Task): string[] => task.tabs.flatMap(tabPanes)
export const activeTabOf = (task: Task): TerminalTab | undefined => task.tabs.find((tab) => tab.id === task.activeTab) ?? task.tabs[0]
export const taskOf = (tasks: Task[], sessionId: string): Task | undefined => tasks.find((task) => taskPanes(task).includes(sessionId))

/** Panes on screen when the app opens: the active tab of the task shown in the workspace, which the Terminal page and the docked panel both show */
export function shownPanes(tasks: Task[], selected: Record<string, string>, workspaceId: string): string[] {
  const task = tasks.find((candidate) => candidate.id === selected[workspaceId]) ?? tasks.find((candidate) => candidate.workspaceId === workspaceId)
  const tab = task && activeTabOf(task)
  return tab ? tabPanes(tab) : []
}

/** Needs input wins over working, working over idle */
export const aggregateStatus = (statuses: SessionStatus[]): TaskStatus => (statuses.includes('input') ? 'input' : statuses.includes('running') ? 'running' : 'idle')

export function newTask(fields: Pick<Task, 'workspaceId' | 'worktreePath'> & Partial<Pick<Task, 'name'>>): Task {
  return { id: crypto.randomUUID(), name: '', tabs: [], activeTab: null, ...fields }
}

/** `base`, else `base 2`, `base 3`… whichever is not taken */
export function uniqueName(base: string, taken: string[]): string {
  let name = base
  for (let number = 2; taken.includes(name); number++) name = `${base} ${number}`
  return name
}

export function addTab(task: Task, sessionId: string): Task {
  const tab: TerminalTab = { id: crypto.randomUUID(), layout: [[sessionId]], focus: sessionId }
  return { ...task, tabs: [...task.tabs, tab], activeTab: tab.id }
}

/** Puts a session beside another in that one's tab; a full tab gets it as a new tab instead, so no session is ever dropped */
function placeOne(tasks: Task[], sessionId: string, targetId: string, edge: DropEdge): Task[] {
  if (sessionId === targetId || !taskOf(tasks, targetId)) return tasks
  return removeSession(tasks, sessionId).map((task) => {
    const tab = task.tabs.find((candidate) => tabPanes(candidate).includes(targetId))
    if (!tab) return task
    if (tabPanes(tab).length >= MAX_PANES) return addTab(task, sessionId)
    return { ...task, tabs: task.tabs.map((candidate) => (candidate === tab ? { ...tab, layout: placePane(tab.layout, sessionId, targetId, edge), focus: sessionId } : candidate)) }
  })
}

/** Puts sessions beside another, e.g. a split, a dragged pane or a dragged tab's panes, which stack in the order given */
export function placeBeside(tasks: Task[], sessionIds: string[], targetId: string, edge: DropEdge): Task[] {
  // A tab dropped onto one of its own panes stays as it is
  if (sessionIds.includes(targetId)) return tasks
  return sessionIds.reduce((next, id, index) => (index === 0 ? placeOne(next, id, targetId, edge) : placeOne(next, id, sessionIds[index - 1], 'bottom')), tasks)
}

/** Drops a session from its tab: focus moves to a neighbouring pane, and an emptied tab closes, the one before it becoming active */
export function removeSession(tasks: Task[], sessionId: string): Task[] {
  return tasks.map((task) => {
    const index = task.tabs.findIndex((tab) => tabPanes(tab).includes(sessionId))
    if (index === -1) return task
    const tabs = task.tabs.flatMap((tab) => {
      if (!tabPanes(tab).includes(sessionId)) return [tab]
      const layout = removePane(tab.layout, sessionId)
      if (layout.length === 0) return []
      const neighbor = (['top', 'left', 'bottom', 'right'] as const).map((edge) => neighborPane(tab.layout, sessionId, edge)).find((id) => id !== null)
      return [{ ...tab, layout, focus: tab.focus === sessionId ? (neighbor ?? layout.flat()[0]) : tab.focus }]
    })
    const activeTab = tabs.some((tab) => tab.id === task.activeTab) ? task.activeTab : (tabs[Math.max(0, index - 1)]?.id ?? null)
    return { ...task, tabs, activeTab }
  })
}

/** Renames sessions after a relaunch, dropping those that did not come back and tabs left empty */
export function remapTasks(tasks: Task[], rename: (id: string) => string | undefined): Task[] {
  return tasks.map((task) => {
    const tabs = task.tabs.flatMap((tab) => {
      const layout = remapPanes(tab.layout, rename)
      return layout.length ? [{ ...tab, layout, focus: rename(tab.focus) ?? layout.flat()[0] }] : []
    })
    return { ...task, tabs, activeTab: tabs.some((tab) => tab.id === task.activeTab) ? task.activeTab : (tabs[0]?.id ?? null) }
  })
}

/** Sessions from before tasks: one task per workspace and worktree, one tab per session, in the order they were shown */
export function tasksFromSessions(sessions: { id: string; worktreePath: string; workspaceId: string }[], shownOrder: string[]): Task[] {
  const rank = (id: string): number => (shownOrder.includes(id) ? shownOrder.indexOf(id) : shownOrder.length)
  const tasks: Task[] = []
  for (const session of [...sessions].sort((a, b) => rank(a.id) - rank(b.id))) {
    const index = tasks.findIndex((task) => task.workspaceId === session.workspaceId && task.worktreePath === session.worktreePath)
    if (index === -1) tasks.push(addTab(newTask({ workspaceId: session.workspaceId, worktreePath: session.worktreePath }), session.id))
    else tasks[index] = addTab(tasks[index], session.id)
  }
  // The first tab of each task shows, as the first shown pane did before
  return tasks.map((task) => ({ ...task, activeTab: task.tabs[0]?.id ?? null }))
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isLayout = (value: unknown): value is PaneLayout => Array.isArray(value) && value.every((column) => Array.isArray(column) && column.every(isString))

/** Saved tasks, skipping anything malformed */
export function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw: unknown): Task[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const task = raw as Record<string, unknown>
    if (!isString(task.id) || !isString(task.workspaceId) || !isString(task.worktreePath)) return []
    const tabs = (Array.isArray(task.tabs) ? task.tabs : []).flatMap((rawTab: unknown): TerminalTab[] => {
      if (typeof rawTab !== 'object' || rawTab === null) return []
      const tab = rawTab as Record<string, unknown>
      return isString(tab.id) && isLayout(tab.layout) && tab.layout.length > 0 ? [{ id: tab.id, layout: tab.layout, focus: isString(tab.focus) ? tab.focus : tab.layout.flat()[0] }] : []
    })
    return [
      {
        id: task.id,
        name: isString(task.name) ? task.name : '',
        workspaceId: task.workspaceId,
        worktreePath: task.worktreePath,
        tabs,
        activeTab: isString(task.activeTab) ? task.activeTab : null
      }
    ]
  })
}
