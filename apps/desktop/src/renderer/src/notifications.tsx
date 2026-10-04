import { useRef, useState, useSyncExternalStore } from 'react'
import { getSettings } from './settings'
import { Icon } from './Icon'
import { timeAgo } from './time'
import { EmptyState, Popup } from './ui'
import { useWorkspaces } from './workspaces'

/** One entry of the notification center; `open` shows what it is about, in `workspaceId` when set */
export type AppNotification = {
  id: string
  title: string
  body: string
  at: number
  read: boolean
  workspaceId: string | null
  open: (() => void) | null
}

// ponytail: kept in memory per window, so a reload or a second window starts empty; persist if that bites
const MAX_NOTIFICATIONS = 100
let notifications: AppNotification[] = []
const listeners = new Set<() => void>()
let switchWorkspace: (id: string) => void = () => undefined

function commit(next: AppNotification[]): void {
  notifications = next
  window.api.setBadge(next.filter((entry) => !entry.read).length)
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const useNotifications = (): AppNotification[] => useSyncExternalStore(subscribe, () => notifications)

/** The app's workspace switch, which notifications in another workspace go through before they open */
export const setWorkspaceSwitcher = (switcher: (id: string) => void): void => {
  switchWorkspace = switcher
}

/** Marks it read and shows what it is about */
export function openNotification(id: string): void {
  const entry = notifications.find((candidate) => candidate.id === id)
  if (!entry) return
  commit(notifications.map((candidate) => (candidate === entry ? { ...candidate, read: true } : candidate)))
  if (entry.workspaceId) switchWorkspace(entry.workspaceId)
  entry.open?.()
}

export const markAllRead = (): void => {
  if (notifications.some((entry) => !entry.read)) commit(notifications.map((entry) => ({ ...entry, read: true })))
}
export const clearNotifications = (): void => commit([])

/**
 * Records it in the notification center, and shows a system notification too while the window is in the background,
 * unless `system` is false or Settings turned agent notifications off
 */
export function notify({
  title,
  body = '',
  workspaceId = null,
  open = null,
  system = true
}: {
  title: string
  body?: string
  workspaceId?: string | null
  open?: (() => void) | null
  system?: boolean
}): void {
  const entry: AppNotification = { id: crypto.randomUUID(), title, body, at: Date.now(), read: false, workspaceId, open }
  // A session ends a turn again (a background task waking it, a blocked Stop hook) before the last notice was read; one entry is enough
  const isRepeat = (candidate: AppNotification): boolean => !candidate.read && candidate.title === title && candidate.body === body && candidate.workspaceId === workspaceId
  commit([entry, ...notifications.filter((candidate) => !isRepeat(candidate))].slice(0, MAX_NOTIFICATIONS))
  if (!system || document.hasFocus() || !getSettings().agentNotifications) return
  const shown = new Notification(title, { body })
  shown.onclick = () => openNotification(entry.id)
}

/** The title bar's bell: unread count, and the list that opens what each entry is about */
export function NotificationCenter(): React.JSX.Element {
  const entries = useNotifications()
  const { workspaces } = useWorkspaces()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const unread = entries.filter((entry) => !entry.read).length
  const close = (): void => {
    setOpen(false)
    markAllRead()
  }
  return (
    <>
      <button
        ref={button}
        title="Notifications"
        aria-label="Notifications"
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag] ${open ? 'bg-foreground/8 text-foreground ring-1 ring-border' : unread > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground tabular-nums">{unread}</span>}
      </button>
      {open && (
        <Popup anchor={button} align="end" onDismiss={close} className="flex max-h-[28rem] w-80 flex-col rounded-lg border border-input bg-popover shadow-lg">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-xs font-medium">
            Notifications
            {entries.length > 0 && (
              <button onClick={clearNotifications} className="text-muted-foreground hover:text-foreground">
                Clear
              </button>
            )}
          </div>
          {entries.length === 0 ? (
            <EmptyState icon="bell" title="No notifications" />
          ) : (
            <div className="min-h-0 overflow-y-auto p-1">
              {entries.map((entry) => {
                const workspace = workspaces.find((candidate) => candidate.id === entry.workspaceId)
                return (
                  <button
                    key={entry.id}
                    onClick={() => {
                      close()
                      openNotification(entry.id)
                    }}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${entry.read ? '' : 'bg-primary'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{entry.title}</span>
                      {entry.body && <span className="block truncate text-muted-foreground">{entry.body}</span>}
                      {workspace && (
                        <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: workspace.color }} />
                          {workspace.name}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{timeAgo(new Date(entry.at).toISOString())}</span>
                  </button>
                )
              })}
            </div>
          )}
        </Popup>
      )}
    </>
  )
}
