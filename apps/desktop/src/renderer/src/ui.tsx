import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

import { errorMessage } from '../../shared/errors'
import { readStored } from './storage'

export { readStored }

export function usePersisted<T extends string | number | boolean | null>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    // A nullable default (e.g. a selection that starts unset) accepts a stored string alongside null itself
    const matches = (candidate: unknown): candidate is T => (initial === null ? candidate === null || typeof candidate === 'string' : typeof candidate === typeof initial)
    const stored = readStored(key)
    return matches(stored) ? stored : initial
  })
  const persist = (next: T): void => {
    localStorage.setItem(key, JSON.stringify(next))
    setValue(next)
  }
  return [value, persist]
}

/** A dragged panel keeps this much, unless it is already drawn smaller */
const PANEL_MIN = { across: 150, vertical: 100 }
/** And leaves this much of the window beyond it for the content it sits beside */
const CONTENT_MIN = { across: 240, vertical: 120 }

/** Drags the panel it sits in, from the size it is drawn at, to any size that keeps it usable and leaves the content beside it room */
export function ResizeHandle({
  onResize,
  edge = 'right'
}: {
  /** Which edge of the panel the handle sits on; `top` resizes height */
  edge?: 'left' | 'right' | 'top'
  onResize: (size: number) => void
}): React.JSX.Element {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    const panel = handle.parentElement?.getBoundingClientRect()
    if (!panel) return
    const size = vertical ? panel.height : panel.width
    const axis = vertical ? 'vertical' : 'across'
    const min = Math.min(size, PANEL_MIN[axis])
    const max = Math.max(size, { right: window.innerWidth - panel.left, left: panel.right, top: panel.bottom }[edge] - CONTENT_MIN[axis])
    const start = vertical ? event.clientY : event.clientX
    const direction = edge === 'right' ? 1 : -1
    handle.setPointerCapture(event.pointerId)
    handle.onpointermove = (move) => {
      const delta = (vertical ? move.clientY : move.clientX) - start
      onResize(Math.round(Math.max(min, Math.min(max, size + direction * delta))))
    }
    handle.onpointerup = () => {
      handle.onpointermove = null
    }
  }
  const vertical = edge === 'top'
  const position = { right: 'inset-y-0 -right-1.5 w-3 cursor-col-resize', left: 'inset-y-0 -left-1.5 w-3 cursor-col-resize', top: 'inset-x-0 -top-1.5 h-3 cursor-row-resize' }
  return (
    <div onPointerDown={startDrag} className={`group absolute z-20 ${position[edge]} [-webkit-app-region:no-drag]`}>
      <ResizeGrip across={vertical} />
    </div>
  )
}

/** The pill on a resizable edge's middle, inside a `group` hit area; `across` lays it flat for an edge dragged up and down */
export function ResizeGrip({ across }: { across: boolean }): React.JSX.Element {
  return (
    <span
      className={`pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors group-hover:bg-foreground/40 group-active:bg-foreground/60 ${
        across ? 'h-1 w-8' : 'h-8 w-1'
      }`}
    />
  )
}

/** Focuses a popup menu's first item when it opens; j k and arrows then move between items, esc closes it, and its keys stay inside */
export function useMenuKeys(
  open: boolean,
  close: () => void,
  selector = 'button'
): { ref: React.RefObject<HTMLDivElement | null>; onKeyDown: (event: React.KeyboardEvent) => void } {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.querySelector('button')?.focus()
  }, [open])
  const onKeyDown = (event: React.KeyboardEvent): void => {
    event.stopPropagation()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
    if (step) {
      event.preventDefault()
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  return { ref, onKeyDown }
}

/** A panel over a dimmed backdrop; a click outside closes it, Escape is up to the caller */
export function Dialog({
  onClose,
  offset,
  className,
  children,
  ...panel
}: { onClose: () => void; offset: string; className: string; children: React.ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'onClick'>): React.JSX.Element {
  return (
    <div className={`fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] ${offset}`} onClick={onClose}>
      <div {...panel} onClick={(event) => event.stopPropagation()} className={`rounded-xl border border-border bg-popover backdrop-blur-2xl ${className}`}>
        {children}
      </div>
    </div>
  )
}

/** True for a moment after `copy` writes to the clipboard, for a check icon that shows the click landed */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, (text) => void navigator.clipboard.writeText(text).then(() => setCopied(true))]
}

/** Copies text and swaps its icon for a check so the click visibly landed */
export function CopyButton({ text, label = 'Copy', className = 'size-3' }: { text: () => string; label?: string; className?: string }): React.JSX.Element {
  const [copied, copy] = useCopied()
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={() => copy(text())}>
      <Icon name={copied ? 'check' : 'copy'} className={`${className} ${copied ? 'text-emerald-400' : ''}`} />
    </IconButton>
  )
}

export function IconButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [-webkit-app-region:no-drag] ${
        active ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  )
}

/** A list header's fold all / unfold all: folds every group while any is open; `z` in the list's zone does the same */
export function FoldAllButton({
  anyOpen,
  groups = 'groups',
  shortcut = 'z',
  onClick
}: {
  anyOpen: boolean
  groups?: string
  shortcut?: string | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <IconButton label={`${anyOpen ? 'Fold' : 'Unfold'} all ${groups}${shortcut ? ` (${shortcut})` : ''}`} onClick={onClick}>
      <Icon name={anyOpen ? 'collapseAll' : 'expandAll'} className="size-3.5" />
    </IconButton>
  )
}

export { errorMessage }

const TOOLTIP_DELAY_MS = 350
const SHORTCUT_SUFFIX = /^(.*?)\s*\(([⌘⇧⌥⌃][^)]*)\)$/s

type Tip = { text: string; shortcut: string | null; x: number; y: number; side: 'below' | 'above' | 'right' }

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
      <div ref={attach} data-popup {...rest} className={`fixed z-[65] ${className}`} />
    </>,
    document.body
  )
}

/** Text cut off with an ellipsis, within a few levels of the pointer: like Finder, hovering it shows the whole text */
function clippedText(from: Element): Element | null {
  for (let element: Element | null = from, depth = 0; element && depth < 3; element = element.parentElement, depth++) {
    if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).textOverflow === 'ellipsis') return element
  }
  return null
}

/** Moves a title to data-tip so the native tooltip stays hidden; an icon button keeps it as its name for VoiceOver */
function moveTitle(element: Element): void {
  const title = element.getAttribute('title')
  if (!title) return
  element.setAttribute('data-tip', title)
  element.removeAttribute('title')
  const named = element.hasAttribute('aria-label') && !element.hasAttribute('data-tip-label')
  if (named || element.textContent?.trim()) return
  element.setAttribute('aria-label', title.match(SHORTCUT_SUFFIX)?.[1] ?? title)
  element.setAttribute('data-tip-label', '')
}

/** Styled tooltips for every `title` in the app */
export function Tooltips(): React.JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let timer = 0
    let target: Element | null = null
    // Like macOS, a clicked control keeps its tip hidden until the pointer leaves it
    let clicked: Element | null = null
    const hide = (): void => {
      clearTimeout(timer)
      target = null
      setTip(null)
    }
    const onOver = (event: MouseEvent): void => {
      const titled = event.target instanceof Element ? event.target.closest('[title], [data-tip]') : null
      const element = titled ?? (event.target instanceof Element ? clippedText(event.target) : null)
      if (element === target) return
      hide()
      if (element !== clicked) clicked = null
      if (!element || element === clicked) return
      moveTitle(element)
      const text = titled ? element.getAttribute('data-tip') : element.textContent?.trim()
      if (!text) return
      target = element
      timer = window.setTimeout(() => {
        if (!element.isConnected) return
        const rect = element.getBoundingClientRect()
        // A full-width list row opts into `data-tip-side="right"`, so the tip sits beside the list rather than over the next row
        const side = element.getAttribute('data-tip-side') === 'right' ? 'right' : rect.bottom + 48 < window.innerHeight ? 'below' : 'above'
        const match = text.match(SHORTCUT_SUFFIX)
        setTip({
          text: match ? match[1] : text,
          shortcut: match?.[2] ?? null,
          x: side === 'right' ? rect.right + 6 : rect.left + rect.width / 2,
          y: side === 'right' ? rect.top + rect.height / 2 : side === 'below' ? rect.bottom + 6 : rect.top - 6,
          side
        })
      }, TOOLTIP_DELAY_MS)
    }
    document.addEventListener('mouseover', onOver)
    // A control whose title changes after it was moved (Preview -> Show source) gets the new tip and name right away
    const retitled = new MutationObserver((records) => records.forEach(({ target }) => target instanceof Element && target.hasAttribute('data-tip') && moveTitle(target)))
    retitled.observe(document.body, { subtree: true, attributeFilter: ['title'] })
    const onDown = (): void => {
      clicked = target
      hide()
    }
    document.addEventListener('mousedown', onDown, true)
    // A resize, a keypress or the pointer leaving the window can move or remove the target without a mouseover
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    document.addEventListener('keydown', hide, true)
    document.documentElement.addEventListener('mouseleave', hide)
    return () => {
      clearTimeout(timer)
      retitled.disconnect()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      document.removeEventListener('keydown', hide, true)
      document.documentElement.removeEventListener('mouseleave', hide)
    }
  }, [])

  if (!tip) return null
  return (
    <div
      // Remounting per tip runs the fit again for each new position
      key={`${tip.x}:${tip.y}:${tip.text}`}
      ref={fitInWindow}
      role="tooltip"
      style={{ left: tip.x, top: tip.y, transform: { below: 'translate(-50%, 0)', above: 'translate(-50%, -100%)', right: 'translate(0, -50%)' }[tip.side] }}
      className="pointer-events-none fixed z-[100] flex w-max max-w-[min(24rem,calc(100vw-16px))] items-center gap-2 rounded-md border border-input bg-popover px-2 py-1 text-[11.5px] break-words whitespace-pre-line text-foreground"
    >
      <span>{tip.text}</span>
      {tip.shortcut && <kbd className="shrink-0 rounded bg-foreground/8 px-1 font-sans text-[10.5px] text-muted-foreground">{tip.shortcut}</kbd>}
    </div>
  )
}

/** An inline problem: an alert mark, the message in plain foreground, and an optional dismiss */
export function Notice({ children, onDismiss, className = '' }: { children: React.ReactNode; onDismiss?: () => void; className?: string }): React.JSX.Element {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-xs leading-4 break-words text-foreground select-text ${className}`}
    >
      <Icon name="alert" className="size-3.5 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} title="Dismiss" aria-label="Dismiss" className="-m-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Icon name="close" className="size-3" />
        </button>
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
    <div className={`flex flex-col items-center justify-center gap-3 px-6 py-8 text-center text-muted-foreground ${fill ? 'min-h-0 min-w-0 flex-1' : ''}`}>
      {icon && <Icon name={icon} className="size-5 opacity-50" />}
      <p className="max-w-80 text-[13px] leading-5 text-balance break-words">{title}</p>
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

/** Both panes hidden: a window with its two panes empty, and nothing to click */
export function NothingOpen(): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 text-muted-foreground select-none">
      <svg viewBox="0 0 160 112" className="w-44 text-foreground" fill="none" aria-hidden>
        <defs>
          <radialGradient id="nothing-open-glow" cx="50%" cy="55%" r="55%">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="nothing-open-frame" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.07" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <ellipse cx="80" cy="62" rx="78" ry="50" fill="url(#nothing-open-glow)" />
        <rect x="16" y="14" width="128" height="84" rx="10" fill="url(#nothing-open-frame)" stroke="currentColor" strokeOpacity="0.18" />
        <path d="M16 30h128" stroke="currentColor" strokeOpacity="0.14" />
        <circle cx="27" cy="22" r="2.2" fill="currentColor" fillOpacity="0.22" />
        <circle cx="35" cy="22" r="2.2" fill="currentColor" fillOpacity="0.22" />
        <circle cx="43" cy="22" r="2.2" fill="currentColor" fillOpacity="0.22" />
        <rect x="24" y="38" width="52" height="52" rx="6" stroke="currentColor" strokeOpacity="0.28" strokeDasharray="4 4" />
        <rect x="84" y="38" width="52" height="52" rx="6" stroke="currentColor" strokeOpacity="0.28" strokeDasharray="4 4" />
        <path d="M44 64h12M50 58v12" stroke="var(--color-primary)" strokeOpacity="0.7" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M104 64h12M110 58v12" stroke="var(--color-primary)" strokeOpacity="0.7" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="text-[13px]">Nothing open</p>
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
  selection,
  onSubmit,
  onClose
}: {
  initialValue?: string
  /** The part of initialValue selected on open; all of it by default */
  selection?: [number, number]
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
    <Dialog onClose={onClose} offset="pt-[18vh]" className="w-[440px] max-w-[90vw] p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      <input
        autoFocus
        // Once, on open: refocusing the window later must not reselect what was typed since
        ref={(input) => {
          if (!input || 'selected' in input.dataset) return
          input.dataset.selected = ''
          if (selection) input.setSelectionRange(...selection)
          else input.select()
        }}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
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
        <button
          onClick={submit}
          disabled={!value.trim() || busy}
          className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:bg-muted disabled:text-muted-foreground"
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}

/** Initials of a display name ("Oleksandr Agniev" is OA) or the start of a login */
const initialsOf = (name: string): string => {
  // Letters and digits only, by code point, so an emoji in a display name never leaves half a character
  const words = (name.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => [...word])
  if (words.length === 0) return [...name.trim()].slice(0, 1).join('')
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0]}` : words[0].slice(0, 2).join('')).toUpperCase()
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
