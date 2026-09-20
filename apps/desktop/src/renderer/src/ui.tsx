import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

/** A stored JSON value, or null when missing or unreadable; callers narrow it */
export function readStored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

export function usePersisted<T extends string | number | boolean>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const matches = (candidate: unknown): candidate is T => typeof candidate === typeof initial
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      return matches(stored) ? stored : initial
    } catch {
      return initial
    }
  })
  const persist = (next: T): void => {
    localStorage.setItem(key, JSON.stringify(next))
    setValue(next)
  }
  return [value, persist]
}

export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  edge = 'right'
}: {
  /** Which edge of the panel the handle sits on; `top` resizes height */
  edge?: 'left' | 'right' | 'top'
  width: number
  min: number
  max: number
  onResize: (size: number) => void
}): React.JSX.Element {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    const vertical = edge === 'top'
    const start = vertical ? event.clientY : event.clientX
    const direction = edge === 'right' ? 1 : -1
    handle.setPointerCapture(event.pointerId)
    handle.onpointermove = (move) => {
      const delta = (vertical ? move.clientY : move.clientX) - start
      onResize(Math.min(max, Math.max(min, width + direction * delta)))
    }
    handle.onpointerup = () => {
      handle.onpointermove = null
    }
  }
  const position = { right: 'inset-y-0 -right-1 w-2 cursor-col-resize', left: 'inset-y-0 -left-1 w-2 cursor-col-resize', top: 'inset-x-0 -top-1 h-2 cursor-row-resize' }
  return (
    <div onPointerDown={startDrag} className={`group absolute z-20 ${position[edge]} [-webkit-app-region:no-drag]`}>
      <div
        className={`bg-transparent group-hover:bg-foreground/20 group-active:bg-foreground/30 ${
          edge === 'top' ? 'my-auto h-px w-full translate-y-[3px]' : 'mx-auto h-full w-px'
        }`}
      />
    </div>
  )
}

/** Copies text and swaps its icon for a check so the click visibly landed */
export function CopyButton({ text, label = 'Copy', className = 'size-3' }: { text: () => string; label?: string; className?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      onClick={() => navigator.clipboard.writeText(text()).then(() => setCopied(true))}
    >
      <Icon name={copied ? 'check' : 'copy'} className={`${className} ${copied ? 'text-emerald-400' : ''}`} />
    </IconButton>
  )
}

export function IconButton({
  label,
  active = false,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag] ${
        active ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  )
}

/** A list header's fold all / unfold all: folds every group while any is open; `z` in the list's zone does the same */
export function FoldAllButton({ anyOpen, groups = 'groups', shortcut = 'z', onClick }: { anyOpen: boolean; groups?: string; shortcut?: string | null; onClick: () => void }): React.JSX.Element {
  return (
    <IconButton label={`${anyOpen ? 'Fold' : 'Unfold'} all ${groups}${shortcut ? ` (${shortcut})` : ''}`} onClick={onClick}>
      <Icon name={anyOpen ? 'collapseAll' : 'expandAll'} className="size-3.5" />
    </IconButton>
  )
}

/** IPC rejections arrive wrapped as "Error invoking remote method 'x': Error: message" */
export const errorMessage = (reason: unknown): string =>
  String(reason).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const TOOLTIP_DELAY_MS = 350
const SHORTCUT_SUFFIX = /^(.*?)\s*\(([⌘⇧⌥⌃][^)]*)\)$/

type Tip = { text: string; shortcut: string | null; x: number; y: number; below: boolean }

const EDGE_GAP = 8

/** Nudges a centered tooltip sideways so its whole width stays inside the window */
function fitInWindow(element: HTMLDivElement | null): void {
  if (!element) return
  const { left, right } = element.getBoundingClientRect()
  const shift = left < EDGE_GAP ? EDGE_GAP - left : right > window.innerWidth - EDGE_GAP ? window.innerWidth - EDGE_GAP - right : 0
  if (shift) element.style.left = `${parseFloat(element.style.left) + shift}px`
}

type Box = { left: number; top: number; right: number; bottom: number }
export type PopupAlign = 'start' | 'end' | 'stretch'
export type PopupSide = 'below' | 'above'
const POPUP_GAP = 4

/**
 * Where a fixed popup of `size` goes next to `trigger`: below unless only above has room, keeping `side` while it still
 * fits so a list that changes as you type doesn't jump; always 8px inside the window, capped to the room on its side
 */
export function placePopup(
  trigger: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: PopupAlign,
  side: PopupSide | null
): { side: PopupSide; left: number; top: number | null; bottom: number | null; maxHeight: number } {
  const room = { below: viewport.height - trigger.bottom - POPUP_GAP - EDGE_GAP, above: trigger.top - POPUP_GAP - EDGE_GAP }
  const fits = (candidate: PopupSide): boolean => size.height <= room[candidate]
  const next: PopupSide = side && fits(side) ? side : fits('below') || room.below >= room.above ? 'below' : 'above'
  const x = align === 'end' ? trigger.right - size.width : trigger.left
  return {
    side: next,
    left: Math.max(EDGE_GAP, Math.min(x, viewport.width - EDGE_GAP - size.width)),
    top: next === 'below' ? trigger.bottom + POPUP_GAP : null,
    bottom: next === 'above' ? viewport.height - trigger.top + POPUP_GAP : null,
    maxHeight: Math.max(0, room[next])
  }
}

/**
 * A menu or suggestion list next to `anchor`, portaled to the body so no clipped or scrolling panel cuts it off, and
 * placed again when its content, the window or a scrolled ancestor changes. `onDismiss` closes it on a click elsewhere.
 * It sits above dialogs and drawers, below the which-key box and tooltips; content that scrolls needs `min-h-0`.
 */
export function Popup({
  anchor,
  align = 'start',
  onDismiss,
  ref,
  className = '',
  ...rest
}: {
  anchor: React.RefObject<Element | null> | DOMRect
  align?: PopupAlign
  onDismiss?: () => void
  ref?: React.RefObject<HTMLDivElement | null>
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const attach = useCallback(
    (popup: HTMLDivElement | null) => {
      if (!popup) return
      if (ref) ref.current = popup
      let side: PopupSide | null = null
      const place = (): void => {
        const trigger = 'current' in anchor ? anchor.current?.getBoundingClientRect() : anchor
        if (!trigger) return
        // Measured at its natural size, then capped again; the cap resets scrolling, so that is kept
        const scrolled = popup.scrollTop
        Object.assign(popup.style, { left: '0px', maxHeight: '', maxWidth: '' })
        if (align === 'stretch') popup.style.width = `${trigger.width}px`
        // Max-h and max-w classes still cap it; the window and the room left only lower those
        const limits = getComputedStyle(popup)
        const cap = parseFloat(limits.maxHeight) || Infinity
        popup.style.maxWidth = `${Math.min(parseFloat(limits.maxWidth) || Infinity, window.innerWidth - 2 * EDGE_GAP)}px`
        const spot = placePopup(trigger, popup.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, align, side)
        side = spot.side
        Object.assign(popup.style, {
          left: `${spot.left}px`,
          top: spot.top === null ? '' : `${spot.top}px`,
          bottom: spot.bottom === null ? '' : `${spot.bottom}px`,
          maxHeight: `${Math.min(cap, spot.maxHeight)}px`
        })
        popup.scrollTop = scrolled
      }
      place()
      const observer = new MutationObserver(place)
      observer.observe(popup, { childList: true, subtree: true, characterData: true })
      const onScroll = (event: Event): void => {
        if (!(event.target instanceof Node && popup.contains(event.target))) place()
      }
      window.addEventListener('resize', place)
      window.addEventListener('scroll', onScroll, true)
      return () => {
        if (ref) ref.current = null
        observer.disconnect()
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', onScroll, true)
      }
    },
    [anchor, align, ref]
  )
  return createPortal(
    <>
      {onDismiss && (
        <div
          className="fixed inset-0 z-[64]"
          onMouseDown={(event) => {
            event.preventDefault()
            onDismiss()
          }}
        />
      )}
      <div ref={attach} {...rest} className={`fixed z-[65] ${className}`} />
    </>,
    document.body
  )
}

/** Styled tooltips for every `title` in the app; the title moves to data-tip so the native one stays hidden */
export function Tooltips(): React.JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let timer = 0
    let target: Element | null = null
    const hide = (): void => {
      clearTimeout(timer)
      target = null
      setTip(null)
    }
    const onOver = (event: MouseEvent): void => {
      const element = event.target instanceof Element ? event.target.closest('[title], [data-tip]') : null
      if (element === target) return
      hide()
      if (!element) return
      const title = element.getAttribute('title')
      if (title) {
        element.setAttribute('data-tip', title)
        element.removeAttribute('title')
      }
      const text = element.getAttribute('data-tip')
      if (!text) return
      target = element
      timer = window.setTimeout(() => {
        if (!element.isConnected) return
        const rect = element.getBoundingClientRect()
        const below = rect.bottom + 48 < window.innerHeight
        const match = text.match(SHORTCUT_SUFFIX)
        setTip({
          text: match ? match[1] : text,
          shortcut: match?.[2] ?? null,
          x: rect.left + rect.width / 2,
          y: below ? rect.bottom + 6 : rect.top - 6,
          below
        })
      }, TOOLTIP_DELAY_MS)
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!tip) return null
  return (
    <div
      // Remounting per tip runs the fit again for each new position
      key={`${tip.x}:${tip.y}:${tip.text}`}
      ref={fitInWindow}
      role="tooltip"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}
      className="pointer-events-none fixed z-[100] flex max-w-sm items-center gap-2 rounded-md border border-input bg-popover px-2 py-1 text-[11.5px] break-words whitespace-pre-line text-foreground shadow-lg shadow-black/40"
    >
      <span>{tip.text}</span>
      {tip.shortcut && (
        <kbd className="shrink-0 rounded bg-foreground/8 px-1 font-sans text-[10.5px] text-muted-foreground">{tip.shortcut}</kbd>
      )}
    </div>
  )
}

/** Centered message for empty and loading states; `fill` centers it in the whole section */
export function EmptyState({
  title,
  icon,
  fill = false,
  children
}: {
  title: React.ReactNode
  icon?: Parameters<typeof Icon>[0]['name']
  fill?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-8 text-center text-muted-foreground ${fill ? 'min-h-0 min-w-0 flex-1' : ''}`}
    >
      {icon && <Icon name={icon} className="size-5 opacity-50" />}
      <p className="max-w-80 text-[13px] leading-5 text-balance break-words">{title}</p>
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

/** Single text field dialog; Electron has no window.prompt */
export function TextPrompt({
  title,
  description,
  placeholder,
  confirmLabel,
  initialValue = '',
  onSubmit,
  onClose
}: {
  initialValue?: string
  title: string
  description?: string
  placeholder?: string
  confirmLabel: string
  onSubmit: (value: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    onSubmit(value.trim())
      .then(onClose)
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] pt-[18vh]" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-popover backdrop-blur-2xl p-4 shadow-2xl shadow-black/60">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') onClose()
          }}
          placeholder={placeholder}
          className="mt-3 h-8 w-full rounded-md border border-input bg-muted px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/70"
        />
        {error && <p className="mt-2 text-xs break-words text-red-400 select-text">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
          <button onClick={submit} disabled={!value.trim() || busy} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Initials of a display name ("Oleksandr Agniev" is OA) or the start of a login */
const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0] ?? ''}` : name.slice(0, 2)).toUpperCase()
}

/** Profile picture, or initials when there is none or it fails to load */
export function UserAvatar({ name, url, size = 'size-[22px]', title = name }: { name: string; url: string | null; size?: string; title?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (url && !failed) return <img src={url} alt="" title={title} onError={() => setFailed(true)} className={`${size} shrink-0 rounded-full bg-accent`} />
  return (
    <span title={title} className={`${size} grid shrink-0 place-items-center rounded-full bg-foreground/15 text-[9px] font-semibold text-foreground uppercase`}>
      {initialsOf(name)}
    </span>
  )
}

/** True while the window has no traffic lights: full screen, or the hotkey window */
export function useChromeless(): boolean {
  const [chromeless, setChromeless] = useState(false)
  useEffect(() => window.api.onWindowChromeless(setChromeless), [])
  return chromeless
}
