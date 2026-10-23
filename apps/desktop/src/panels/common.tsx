import { useContext, useEffect, useRef, type ReactNode } from 'react'
import type { CreateSession, Place } from '../ipc/api'
import { Icon, type IconName } from '../lib/icons'
import { paneGrid } from '../panes/terminal/xterm'
import { newTabId } from '../shell/state'
import { GroupColors, placeColor, placeIcon, placeName } from '../shell/model'
import type { ShellView } from '../shell/Shell'

// Line icons only the panels use, same 24px stroke style as lib/icons
const PANEL_ICONS = {
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3l-2 3 2 3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  collapse: '<path d="M7 20l5-5 5 5M7 4l5 5 5-5"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  wifiOff: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.7M16.8 11.1A10 10 0 0 1 19 12.9M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  tree: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
} as const

export type PanelIconName = keyof typeof PANEL_ICONS

export function PIcon({ name }: { name: PanelIconName | IconName }) {
  if (name in PANEL_ICONS) return <svg viewBox="0 0 24 24" aria-hidden dangerouslySetInnerHTML={{ __html: PANEL_ICONS[name as PanelIconName] }} />
  return <Icon name={name as IconName} />
}

export const isGit = (place: Place) => place.kind !== 'folder' && place.kind !== 'scratch'

/** The place a panel shows, as the header chip */
export function PlaceTag({ place }: { place: Place }) {
  const colors = useContext(GroupColors)
  if (place.kind === 'scratch')
    return (
      <span className="tag">
        <Icon name="home" />~
      </span>
    )
  if (place.kind === 'folder')
    return (
      <span className="tag" title="Not a git repository">
        <Icon name="folder" />
        <span className="trunc">{place.name} · not git</span>
      </span>
    )
  return (
    <span className="tag" style={{ color: placeColor(place, colors) }} title={place.path}>
      <Icon name={placeIcon(place)} />
      <span className="trunc">{placeName(place)}</span>
    </span>
  )
}

export function NoFolder({ view, what }: { view: ShellView; what: string }) {
  return (
    <div className="empty">
      <Icon name="home" />
      <div style={{ margin: '6px 0 10px' }}>This session runs in ~, not in a project folder, so there {what}.</div>
      <button className="btn sm" onClick={() => view.run('open-folder')}>
        <Icon name="folder" />
        Open folder...
      </button>
    </div>
  )
}

export interface MenuItem {
  label: string
  icon?: PanelIconName | IconName
  danger?: boolean
  /** A swatch before the label */
  color?: string
  run: () => void
}

/** Context menu at a point; closes on pick, outside click or Escape */
export function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return (
    <div ref={ref} className="pop menu" style={{ left: Math.min(at.x, innerWidth - 240), top: Math.min(at.y, innerHeight - items.length * 28 - 12) }}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`mi ${item.danger ? 'err' : ''}`}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          {item.icon && <PIcon name={item.icon} />}
          {item.color && <span className="sw" style={{ background: item.color }} />}
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** Opens a new session in its own tab, sized to the center card */
export async function openSession(view: ShellView, opts: Omit<CreateSession, 'cols' | 'rows'>) {
  const box = document.querySelector('main.center')?.getBoundingClientRect()
  const info = await view.api.create({ ...opts, ...paneGrid(box?.width ?? innerWidth, box?.height ?? innerHeight) })
  view.dispatch({ type: 'open', session: info.id, tabId: newTabId() })
  return info
}

/** Types a command into a new shell in `cwd`, like the prototype's runIn: the user sees it run and can answer prompts */
export async function runIn(view: ShellView, cwd: string, command: string) {
  const info = await openSession(view, { kind: 'shell', cwd })
  await view.api.write(info.id, `${command}\r`)
}

/** Starts an agent with a first prompt */
export const askAgent = (view: ShellView, kind: 'claude' | 'codex', cwd: string, prompt: string, title?: string) =>
  openSession(view, { kind, cwd, command: [kind, prompt], title })

/** The panel header: title, the place chip, then actions */
export function Head({ title, place, children }: { title: string; place?: Place; children?: ReactNode }) {
  return (
    <div className="ph">
      <h2>
        {title}
        {place && <PlaceTag place={place} />}
      </h2>
      {children}
    </div>
  )
}
