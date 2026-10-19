const dot = (cx: number, cy: number): React.JSX.Element => <circle cx={cx} cy={cy} r="1.3" fill="currentColor" stroke="none" />

/** Robot faces on a 24px grid, drawn in the text colour for Treeix bots */
const MARK_PATHS = {
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="4" />
      <path d="M12 8V5" />
      {dot(12, 3.8)}
      {dot(9, 14)}
      {dot(15, 14)}
    </>
  ),
  visor: (
    <>
      <rect x="3.5" y="6" width="17" height="13" rx="6.5" />
      <rect x="7.5" y="11" width="9" height="3" rx="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  cyclops: (
    <>
      <circle cx="12" cy="13.5" r="7" />
      <circle cx="12" cy="13.5" r="2.4" fill="currentColor" stroke="none" />
      <path d="M8.5 7.5L7 4.5M15.5 7.5L17 4.5" />
    </>
  ),
  happy: (
    <>
      <rect x="4" y="6" width="16" height="13" rx="5" />
      <path d="M7.8 12.5q1.2-1.6 2.4 0M13.8 12.5q1.2-1.6 2.4 0M10 15.8h4" />
    </>
  ),
  headset: (
    <>
      <rect x="6.5" y="6" width="11" height="13" rx="4" />
      <path d="M6.5 11H4.5v4h2M17.5 11h2v4h-2" />
      {dot(10, 11.5)}
      {dot(14, 11.5)}
      <path d="M10.5 15.5h3" />
    </>
  ),
  ghost: (
    <>
      <path d="M5 20v-8.5a7 7 0 0 1 14 0V20l-2.3-1.5-2.4 1.5-2.3-1.5-2.3 1.5-2.4-1.5z" />
      {dot(9.5, 11.5)}
      {dot(14.5, 11.5)}
    </>
  ),
  cat: (
    <>
      <path d="M5 4.5l4 3.5h6l4-3.5V15a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" />
      {dot(9.5, 12.5)}
      {dot(14.5, 12.5)}
      <path d="M11.2 15.5h1.6" />
    </>
  ),
  wink: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="4" />
      <path d="M12 8V6l2.5-2" />
      {dot(9, 14)}
      <path d="M13.8 14h2.4" />
    </>
  ),
  screen: (
    <>
      <rect x="3.5" y="7" width="17" height="11.5" rx="3" />
      <path d="M9 3.5l3 3.5 3-3.5M9 21.5h6M9.5 13.8q2.5 1.8 5 0" />
      {dot(9, 10.8)}
      {dot(15, 10.8)}
    </>
  )
} satisfies Record<string, React.JSX.Element>

export type BotMark = keyof typeof MARK_PATHS
export const BOT_MARKS = Object.keys(MARK_PATHS) as BotMark[]
export const BOT_COLORS = ['#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#ef4444', '#eab308', '#64748b']

/** `mark` is one of BOT_MARKS; anything else, like a bot saved before these marks, shows the first */
export type BotLook = { color: string; mark: string }

const isMark = (mark: string): mark is BotMark => mark in MARK_PATHS

/** A bot's mark on its own, in the text colour */
export function BotMarkIcon({ mark, className }: { mark: string; className: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {MARK_PATHS[isMark(mark) ? mark : BOT_MARKS[0]]}
    </svg>
  )
}

/** A bot's face: its mark on a tile of its colour */
export function BotAvatar({ look, className = 'size-7', attention = false }: { look: BotLook; className?: string; attention?: boolean }): React.JSX.Element {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full text-white ${className}`}
      style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${look.color} 82%, white), ${look.color} 50%, color-mix(in oklab, ${look.color} 80%, black))` }}
    >
      <BotMarkIcon mark={look.mark} className="size-[62%] drop-shadow-[0_1px_1px_rgb(0_0_0/0.3)]" />
      {attention && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-background" />}
    </span>
  )
}
