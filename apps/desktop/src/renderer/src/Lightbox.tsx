import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useChromeless } from './ui'

const ZOOM_RANGE = { min: 0.2, max: 8 }
const STEP = 1.25
const clamp = (zoom: number): number => Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, zoom))

/** Full-screen view of one image or diagram: scroll or +/- to zoom, drag to move, Esc to close */
export function Lightbox({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  // The overlay covers the title bar, so the toolbar keeps clear of the traffic lights
  const chromeless = useChromeless()
  const drag = useRef<{ x: number; y: number } | null>(null)
  const reset = (): void => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === '+' || event.key === '=') setZoom((current) => clamp(current * STEP))
      else if (event.key === '-') setZoom((current) => clamp(current / STEP))
      else if (event.key === '0') reset()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
      onWheel={(event) => {
        const next = clamp(zoom * (event.deltaY < 0 ? STEP : 1 / STEP))
        setZoom(next)
      }}
    >
      <div className={`flex h-11 shrink-0 items-center gap-2 pr-4 text-xs text-white/70 ${chromeless ? 'pl-4' : 'pl-[86px]'}`} onClick={(event) => event.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button onClick={() => setZoom(clamp(zoom / STEP))} aria-label="Zoom out" className="grid size-7 place-items-center rounded-md hover:bg-white/10 hover:text-white">
          −
        </button>
        <button onClick={reset} className="h-7 rounded-md px-2 tabular-nums hover:bg-white/10 hover:text-white">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom(clamp(zoom * STEP))} aria-label="Zoom in" className="grid size-7 place-items-center rounded-md hover:bg-white/10 hover:text-white">
          +
        </button>
        <button onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md hover:bg-white/10 hover:text-white">
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
      <div
        className={`flex min-h-0 flex-1 items-center justify-center overflow-hidden ${drag.current ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => drag.current && setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y })}
        onPointerUp={() => (drag.current = null)}
        // The backdrop closes on click; the picture itself must not
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={reset}
      >
        <div
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          className="max-h-full max-w-full [&>img]:max-h-[85vh] [&>img]:max-w-[92vw] [&>svg]:max-h-[85vh] [&>svg]:max-w-[92vw]"
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Wraps something clickable that opens in the lightbox */
export function Expandable({ title, preview, children }: { title?: string; preview: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} title="Click to open full screen" className="block max-w-full cursor-zoom-in">
        {preview}
      </button>
      {open && (
        <Lightbox title={title} onClose={() => setOpen(false)}>
          {children}
        </Lightbox>
      )}
    </>
  )
}
