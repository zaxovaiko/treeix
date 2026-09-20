import { useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Popup } from './ui'

/** Panels come from plugins, like the terminal */
export type PanelId = string
export type DockSide = 'left' | 'right' | 'bottom'
export type PanelInfo = { label: string; icon: IconName; shortcut: string }

export type Layout = {
  docks: Record<DockSide, PanelId[]>
  active: Record<DockSide, PanelId | null>
  hidden: PanelId[]
  sizes: Record<DockSide, number>
}

const SIDES: DockSide[] = ['left', 'right', 'bottom']
const LAYOUT_KEY = 'layout'
export const SIZE_LIMITS: Record<DockSide, [number, number]> = { left: [220, 640], right: [220, 640], bottom: [160, 800] }
/** Where a panel docks before it was ever moved */
const DEFAULT_SIDE: Record<string, DockSide> = { terminal: 'bottom' }

const DEFAULT_LAYOUT: Layout = {
  docks: { left: [], right: [], bottom: [] },
  active: { left: null, right: null, bottom: 'terminal' },
  hidden: ['terminal'],
  sizes: { left: 320, right: 320, bottom: 320 }
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

function isLayout(value: unknown): value is Layout {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Layout>
  return (
    SIDES.every((side) => isStringList(candidate.docks?.[side]) && typeof candidate.sizes?.[side] === 'number') &&
    isStringList(candidate.hidden) &&
    typeof candidate.active === 'object'
  )
}

// The terminal panel starts closed; starting a session opens it, and it closes again when the last one exits
function loadLayout(): Layout {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    return isLayout(stored) ? stored : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Panels that appeared since the layout was saved go to their default side; ones from disabled plugins keep their place for later */
function withPanels(layout: Layout, panelIds: PanelId[]): Layout {
  const missing = panelIds.filter((id) => !SIDES.some((side) => layout.docks[side].includes(id)))
  if (missing.length === 0) return layout
  const docks = { ...layout.docks }
  for (const id of missing) {
    const side = DEFAULT_SIDE[id] ?? 'right'
    docks[side] = [...docks[side], id]
  }
  return { ...layout, docks }
}

export function useLayout(panelIds: PanelId[]): {
  layout: Layout
  sideOf: (id: PanelId) => DockSide
  visiblePanel: (side: DockSide) => PanelId | null
  isVisible: (id: PanelId) => boolean
  toggle: (id: PanelId) => void
  show: (id: PanelId) => void
  hide: (id: PanelId) => void
  move: (id: PanelId, side: DockSide) => void
  resize: (side: DockSide, size: number) => void
} {
  const [stored, setStored] = useState(loadLayout)
  // Stable while nothing changes, so the plugin host built from it stays stable too
  const panelKey = panelIds.join('\0')
  const layout = useMemo(() => withPanels(stored, panelIds), [stored, panelKey])

  const save = (next: Layout): void => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
    setStored(next)
  }
  const sideOf = (id: PanelId): DockSide => SIDES.find((side) => layout.docks[side].includes(id)) ?? DEFAULT_SIDE[id] ?? 'right'
  const visiblePanel = (side: DockSide): PanelId | null => {
    const shown = layout.docks[side].filter((id) => panelIds.includes(id) && !layout.hidden.includes(id))
    const active = layout.active[side]
    return active && shown.includes(active) ? active : (shown[0] ?? null)
  }
  const isVisible = (id: PanelId): boolean => visiblePanel(sideOf(id)) === id
  const show = (id: PanelId): void =>
    save({
      ...layout,
      hidden: layout.hidden.filter((panel) => panel !== id),
      active: { ...layout.active, [sideOf(id)]: id }
    })
  const hide = (id: PanelId): void => save({ ...layout, hidden: [...layout.hidden.filter((panel) => panel !== id), id] })
  const toggle = (id: PanelId): void => (isVisible(id) ? save({ ...layout, hidden: [...layout.hidden, id] }) : show(id))
  const move = (id: PanelId, side: DockSide): void => {
    const docks = Object.fromEntries(SIDES.map((dock) => [dock, layout.docks[dock].filter((panel) => panel !== id)]))
    save({
      ...layout,
      docks: { left: docks.left, right: docks.right, bottom: docks.bottom, [side]: [...docks[side], id] },
      active: { ...layout.active, [side]: id },
      hidden: layout.hidden.filter((panel) => panel !== id)
    })
  }
  const resize = (side: DockSide, size: number): void => save({ ...layout, sizes: { ...layout.sizes, [side]: size } })

  return { layout, sideOf, visiblePanel, isVisible, toggle, show, hide, move, resize }
}

export function DropZones({ onDrop }: { onDrop: (side: DockSide) => void }): React.JSX.Element {
  const [over, setOver] = useState<DockSide | null>(null)
  const placement: Record<DockSide, string> = {
    left: 'top-3 bottom-3 left-3 w-56',
    right: 'top-3 right-3 bottom-3 w-56',
    bottom: 'right-64 bottom-3 left-64 h-36'
  }
  return (
    <>
      {SIDES.map((side) => (
        <div
          key={side}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(side)
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(event) => {
            event.preventDefault()
            onDrop(side)
          }}
          className={`absolute z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/40 text-sm font-medium text-foreground capitalize ${
            placement[side]
          } ${over === side ? 'bg-foreground/[.12]' : 'bg-foreground/[.04]'}`}
        >
          Dock {side}
        </div>
      ))}
    </>
  )
}

export function PanelToggle({
  id,
  info,
  active,
  side,
  badge,
  onToggle,
  onMove,
  onDragStart,
  onDragEnd
}: {
  id: PanelId
  info: PanelInfo
  active: boolean
  side: DockSide
  badge?: React.ReactNode
  onToggle: () => void
  onMove: (side: DockSide) => void
  onDragStart: () => void
  onDragEnd: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const { label, icon, shortcut } = info
  return (
    <div className="relative [-webkit-app-region:no-drag]">
      <button
        ref={button}
        draggable
        title={`${label} (${shortcut}) · drag to dock, right-click to move`}
        aria-label={label}
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', id)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        className={`relative inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground ${
          active ? 'bg-accent text-foreground' : 'text-muted-foreground'
        }`}
      >
        <Icon name={icon} />
        {badge}
      </button>
      {menuOpen && (
        <Popup anchor={button} align="end" onDismiss={() => setMenuOpen(false)} className="w-40 overflow-y-auto rounded-lg border border-input bg-popover p-1">
          {SIDES.filter((target) => target !== side).map((target) => (
            <button
              key={target}
              onClick={() => {
                setMenuOpen(false)
                onMove(target)
              }}
              className="flex h-7 w-full items-center rounded-md px-2 text-left text-xs hover:bg-accent"
            >
              Move to {target}
            </button>
          ))}
        </Popup>
      )}
    </div>
  )
}
