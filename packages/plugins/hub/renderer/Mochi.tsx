import { useEffect, useId, useRef } from 'react'
import './mochi.css'

export type Mood = 'idle' | 'working' | 'waiting' | 'done' | 'failed'

const BODY = 'M60 12c34 0 48 8 48 40s-14 40-48 40S12 84 12 52s14-40 48-40Z'

/** The hub's agent at any size: tinted per agent, a badge for its mood once big enough, eyes on the pointer when `follow` */
export function Mochi({ mood, size, tint, follow = false }: { mood: Mood; size: number; tint?: string; follow?: boolean }): React.JSX.Element {
  const id = useId()
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!follow) return
    const onMove = (event: PointerEvent): void => {
      const box = svg.current?.getBoundingClientRect()
      if (!box?.width) return
      const dx = event.clientX - (box.left + box.width / 2)
      const dy = event.clientY - (box.top + box.height / 2)
      const reach = Math.hypot(dx, dy) || 1
      const pull = Math.min(1, reach / 300)
      svg.current?.style.setProperty('--ex', `${(dx / reach) * 6 * pull}px`)
      svg.current?.style.setProperty('--ey', `${(dy / reach) * 4 * pull}px`)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [follow])
  // A click squishes it, for fun
  const poke = (): void => {
    svg.current?.classList.remove('poked')
    void svg.current?.getBoundingClientRect()
    svg.current?.classList.add('poked')
  }
  return (
    <svg
      ref={svg}
      className="mochi shrink-0"
      data-mood={mood}
      viewBox="-14 -18 148 132"
      width={size}
      height={Math.round(size * 0.9)}
      onClick={follow ? poke : undefined}
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbf7f1" />
          <stop offset=".5" stopColor="#e9ecfb" />
          <stop offset="1" stopColor="#8f9cff" />
        </linearGradient>
        <radialGradient id={`${id}shine`} cx=".32" cy=".22" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}glow`} cx=".5" cy=".55" r=".5">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity=".45" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {size > 60 && <ellipse cx="60" cy="58" rx="74" ry="62" fill={`url(#${id}glow)`} />}
      <g className="bob">
        <path className="body-fill" d={BODY} fill={tint ?? `url(#${id}body)`} />
        <path d={BODY} fill={`url(#${id}shine)`} />
        <ellipse cx="33" cy="64" rx="8" ry="4.5" fill="#ff8aa0" opacity=".35" />
        <ellipse cx="87" cy="64" rx="8" ry="4.5" fill="#ff8aa0" opacity=".35" />
        <g className="eyes">
          <g className="lids">
            <ellipse cx="47" cy="58" rx="5" ry="6.5" fill="#141414" />
            <ellipse cx="73" cy="58" rx="5" ry="6.5" fill="#141414" />
          </g>
          <path className="happy" d="M41 60q6-8 12 0M67 60q6-8 12 0" fill="none" stroke="#141414" strokeWidth="3.5" strokeLinecap="round" />
        </g>
      </g>
      {size > 40 && (
        <g className="badge">
          <g className="b-work">
            <rect x="-6" y="-6" width="40" height="22" rx="11" fill="var(--color-primary)" stroke="#121212" strokeWidth="3" />
            <circle cx="5" cy="5" r="3" fill="#fff" />
            <circle cx="14" cy="5" r="3" fill="#fff" />
            <circle cx="23" cy="5" r="3" fill="#fff" />
          </g>
          <g className="b-wait">
            <circle cx="8" cy="5" r="13" fill="#fbbf24" stroke="#121212" strokeWidth="3" />
            <text x="8" y="11" textAnchor="middle" fontSize="17" fontWeight="800" fill="#1a1a1a">
              ?
            </text>
          </g>
          <g className="b-done">
            <circle cx="8" cy="5" r="13" fill="#34d399" stroke="#121212" strokeWidth="3" />
            <path d="m2 5 4 4 8-8" fill="none" stroke="#0b2b1f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <g className="b-fail">
            <circle cx="8" cy="5" r="13" fill="#f87171" stroke="#121212" strokeWidth="3" />
            <text x="8" y="11" textAnchor="middle" fontSize="17" fontWeight="800" fill="#2b0b0b">
              !
            </text>
          </g>
        </g>
      )}
    </svg>
  )
}
