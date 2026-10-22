import { useEffect, useRef, type ReactNode } from 'react'

/** A popover under or above `anchor` (above when it sits in the lower half, right-aligned in the right half), like the prototype's openPop */
export function Pop({ anchor, className, onClose, children }: { anchor: DOMRect; className?: string; onClose: () => void; children: ReactNode }) {
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
  const below = anchor.top < innerHeight / 2
  const left = anchor.left + anchor.width / 2 < innerWidth / 2
  return (
    <div
      ref={ref}
      className={`pop fpop ${className ?? ''}`}
      style={{
        top: below ? anchor.bottom + 6 : undefined,
        bottom: below ? undefined : innerHeight - anchor.top + 6,
        left: left ? anchor.left : undefined,
        right: left ? undefined : innerWidth - anchor.right,
      }}
    >
      {children}
    </div>
  )
}
