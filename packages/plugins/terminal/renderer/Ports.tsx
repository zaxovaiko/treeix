import { useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '@treeix/app/Icon'
import { Popup } from '@treeix/app/ui'
import { getPorts, killPort, subscribeTerminals } from './terminals'

/** Ports the sessions' servers listen on, each with a way to stop it; hidden while there are none */
export function Ports(): React.JSX.Element | null {
  const ports = useSyncExternalStore(subscribeTerminals, getPorts)
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!ports.length) return null
  const label = `${ports.length} open ${ports.length === 1 ? 'port' : 'ports'}`
  return (
    <>
      <button
        ref={anchor}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
      >
        <Icon name="network" className="size-3.5" />
        {ports.length}
      </button>
      {open && (
        <Popup anchor={anchor} align="end" onDismiss={() => setOpen(false)} className="w-72 rounded-lg border border-input bg-popover p-1 text-foreground">
          {ports.map((port) => (
            <div key={`${port.sessionId}:${port.port}`} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px]">localhost:{port.port}</div>
                <div className="truncate text-[10px] text-muted-foreground">{[port.command, port.cwd].filter(Boolean).join(' · ')}</div>
              </div>
              <button onClick={() => void killPort(port)} className="h-5 shrink-0 rounded border border-border px-1.5 text-[11px] text-red-400 hover:bg-red-400/12">
                Kill
              </button>
            </div>
          ))}
        </Popup>
      )}
    </>
  )
}
