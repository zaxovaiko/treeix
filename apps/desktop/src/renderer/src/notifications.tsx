import { getSettings } from './settings'

/** Something an agent did while the user looked elsewhere; `open` shows what it is about, in `workspaceId` when set. The dock badge counts the unread ones */
export type AppNotification = {
  id: string
  title: string
  body: string
  at: number
  read: boolean
  workspaceId: string | null
  failed: boolean
  open: (() => void) | null
}

// ponytail: kept in memory per window, so a reload or a second window starts empty; persist if that bites
const MAX_NOTIFICATIONS = 100
let notifications: AppNotification[] = []
let switchWorkspace: (id: string) => void = () => undefined

function commit(next: AppNotification[]): void {
  notifications = next
  window.api.setBadge(next.filter((entry) => !entry.read).length)
}

/** The app's workspace switch, which notifications in another workspace go through before they open */
export const setWorkspaceSwitcher = (switcher: (id: string) => void): void => {
  switchWorkspace = switcher
}

/** Marks it read and shows what it is about */
function openNotification(id: string): void {
  const entry = notifications.find((candidate) => candidate.id === id)
  if (!entry) return
  commit(notifications.map((candidate) => (candidate === entry ? { ...candidate, read: true } : candidate)))
  if (entry.workspaceId) switchWorkspace(entry.workspaceId)
  entry.open?.()
}

const markAllRead = (): void => {
  if (notifications.some((entry) => !entry.read)) commit(notifications.map((entry) => ({ ...entry, read: true })))
}

// What needs the user is in the sidebar once the app is in front, so the badge only counts news from while it wasn't
window.addEventListener('focus', markAllRead)

/**
 * Records it as unread, and shows a system notification too while the window is in the background,
 * unless `system` is false or Settings turned agent notifications off
 */
export function notify({
  title,
  body = '',
  workspaceId = null,
  open = null,
  system = true,
  failed = false
}: {
  title: string
  body?: string
  workspaceId?: string | null
  open?: (() => void) | null
  system?: boolean
  failed?: boolean
}): void {
  const entry: AppNotification = {
    id: crypto.randomUUID(),
    title,
    body,
    at: Date.now(),
    read: false,
    workspaceId,
    failed,
    open
  }
  // A session ends a turn again (a background task waking it, a blocked Stop hook) before the last notice was read; one entry is enough
  const isRepeat = (candidate: AppNotification): boolean => !candidate.read && candidate.title === title && candidate.body === body && candidate.workspaceId === workspaceId
  commit([entry, ...notifications.filter((candidate) => !isRepeat(candidate))].slice(0, MAX_NOTIFICATIONS))
  if (!system || document.hasFocus() || !getSettings().agentNotifications) return
  const shown = new Notification(title, { body })
  shown.onclick = () => openNotification(entry.id)
}
