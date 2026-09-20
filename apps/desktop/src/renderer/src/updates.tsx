import { useEffect, useSyncExternalStore } from 'react'
import type { UpdateStatus } from '../../shared/types'
import { Icon } from './Icon'

let status: UpdateStatus = { current: '', phase: 'idle' }
const listeners = new Set<() => void>()
let started = false

function set(next: UpdateStatus): void {
  status = next
  listeners.forEach((listener) => listener())
}

/** The main process owns the checking; this mirrors its status for anything on screen that shows it */
export function useUpdates(): UpdateStatus {
  useEffect(() => {
    if (started) return
    started = true
    void window.api.updates.status().then(set)
    window.api.updates.on(set)
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status
  )
}

export const checkForUpdates = (): Promise<void> => window.api.updates.check().then(set)

/** One line for Settings and the banner: what the updater is doing right now */
export function updateSummary(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates'
    case 'available':
      return `Treeix ${status.version} found, downloading`
    case 'downloading':
      return `Downloading Treeix ${status.version ?? ''} ${status.percent ?? 0}%`.replace('  ', ' ')
    case 'ready':
      return `Treeix ${status.version} is ready to install`
    case 'unsupported':
      return status.message ?? 'Updates are handled elsewhere for this build'
    case 'error':
      return `Could not check for updates: ${status.message ?? 'unknown error'}`
    default:
      return `Treeix ${status.current} is up to date`
  }
}

/**
 * The downloaded version waiting for a restart. Dismissing keeps it installed on the next quit, so the offer
 * comes back only when the app reopens or a newer build arrives.
 */
export function UpdateBanner({ onDismiss }: { onDismiss: () => void }): React.JSX.Element | null {
  const status = useUpdates()
  if (status.phase !== 'ready') return null
  return (
    <div className="fixed right-3 bottom-3 z-50 flex items-center gap-2.5 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-2xl shadow-black/60">
      <Icon name="refresh" className="size-3.5 shrink-0 text-primary" />
      <span className="text-foreground">Treeix {status.version} is ready</span>
      <button onClick={() => window.api.updates.install()} className="h-6 shrink-0 rounded-md bg-foreground/10 px-2 font-medium text-foreground ring-1 ring-border hover:bg-accent">
        Restart now
      </button>
      <button aria-label="Later" title="Later; it installs when you quit" onClick={onDismiss} className="shrink-0 text-muted-foreground hover:text-foreground">
        <Icon name="close" className="size-3.5" />
      </button>
    </div>
  )
}
