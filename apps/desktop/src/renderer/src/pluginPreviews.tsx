/** Filled shapes in a preview, one tone under the strokes */
const SHADE = { fill: 'currentColor', stroke: 'none', opacity: 0.3 } as const

/** A line drawing of what each plugin adds, in the text color, keyed by plugin id */
const DRAWINGS: Record<string, React.JSX.Element> = {
  'agent-usage': (
    <>
      <path d="M8 34h48" />
      <rect x="12" y="24" width="6" height="10" rx="1" {...SHADE} />
      <rect x="22" y="14" width="6" height="20" rx="1" {...SHADE} />
      <rect x="32" y="19" width="6" height="15" rx="1" {...SHADE} />
      <rect x="42" y="8" width="6" height="26" rx="1" />
    </>
  ),
  browser: (
    <>
      <rect x="6" y="5" width="52" height="30" rx="3" />
      <path d="M6 13h52" />
      <circle cx="11" cy="9" r="1" {...SHADE} opacity={1} />
      <circle cx="15" cy="9" r="1" {...SHADE} opacity={1} />
      <rect x="22" y="7.5" width="30" height="3" rx="1.5" {...SHADE} />
      <path d="M12 20h22M12 25h16M12 30h20" />
    </>
  ),
  plans: (
    <>
      <rect x="10" y="6" width="7" height="7" rx="1.5" />
      <path d="m11.5 9.5 1.5 1.5 3-3M22 9.5h30" />
      <rect x="10" y="17" width="7" height="7" rx="1.5" />
      <path d="m11.5 20.5 1.5 1.5 3-3M22 20.5h24" />
      <rect x="10" y="28" width="7" height="7" rx="1.5" />
      <path d="M22 31.5h28" opacity={0.5} />
    </>
  ),
  confluence: (
    <>
      <circle cx="10" cy="9" r="2" />
      <path d="M10 11v18M10 19h6M10 29h6" />
      <circle cx="18" cy="19" r="2" {...SHADE} opacity={1} />
      <circle cx="18" cy="29" r="2" />
      <rect x="28" y="5" width="28" height="30" rx="2" />
      <path d="M33 11h14M33 17h18M33 22h16M33 27h12" />
    </>
  ),
  dependencies: (
    <>
      <path d="M32 10 18 20M32 10l14 10M18 20l14 11M46 20 32 31M18 20l-8 11" />
      <circle cx="32" cy="8" r="3" {...SHADE} opacity={1} />
      <circle cx="18" cy="20" r="3" />
      <circle cx="46" cy="20" r="3" />
      <circle cx="32" cy="32" r="3" />
      <circle cx="10" cy="32" r="3" />
    </>
  ),
  schema: (
    <>
      <rect x="6" y="6" width="20" height="26" rx="2" />
      <rect x="6" y="6" width="20" height="6" rx="2" {...SHADE} />
      <path d="M10 17h12M10 22h9M10 27h11" />
      <rect x="38" y="12" width="20" height="22" rx="2" />
      <rect x="38" y="12" width="20" height="6" rx="2" {...SHADE} />
      <path d="M42 23h12M42 28h8M26 22h6v6h6" />
    </>
  ),
  dictation: (
    <>
      <rect x="28" y="5" width="8" height="17" rx="4" {...SHADE} />
      <rect x="28" y="5" width="8" height="17" rx="4" />
      <path d="M22 17a10 10 0 0 0 20 0M32 27v7M27 34h10M14 15v6M10 13v10M50 15v6M54 13v10" />
    </>
  ),
  env: (
    <>
      <path d="M8 10h14M26 9h3M26 11h3M33 10h22" />
      <path d="M8 20h10M26 19h3M26 21h3" />
      <circle cx="35" cy="20" r="1.5" {...SHADE} opacity={1} />
      <circle cx="40" cy="20" r="1.5" {...SHADE} opacity={1} />
      <circle cx="45" cy="20" r="1.5" {...SHADE} opacity={1} />
      <circle cx="50" cy="20" r="1.5" {...SHADE} opacity={1} />
      <path d="M8 30h12M26 29h3M26 31h3M33 30h16" strokeDasharray="2 3" />
    </>
  ),
  jira: (
    <>
      <path d="M6 7h14M25 7h14M44 7h14" />
      <rect x="6" y="11" width="14" height="8" rx="1.5" {...SHADE} />
      <rect x="6" y="22" width="14" height="8" rx="1.5" />
      <rect x="25" y="11" width="14" height="8" rx="1.5" />
      <rect x="44" y="11" width="14" height="8" rx="1.5" />
      <rect x="44" y="22" width="14" height="8" rx="1.5" {...SHADE} />
    </>
  ),
  'keep-awake': (
    <>
      <path d="M20 16h20v8a9 9 0 0 1-9 9h-2a9 9 0 0 1-9-9z" {...SHADE} />
      <path d="M20 16h20v8a9 9 0 0 1-9 9h-2a9 9 0 0 1-9-9zM40 19h3a4 4 0 0 1 0 8h-3" />
      <path d="M25 6c-2 2.5 2 3.5 0 6M31 6c-2 2.5 2 3.5 0 6M37 6c-2 2.5 2 3.5 0 6" />
    </>
  ),
  meetings: (
    <>
      <rect x="8" y="10" width="32" height="20" rx="3" />
      <path d="m40 17 12-6v18l-12-6" />
      <circle cx="15" cy="16" r="2.5" {...SHADE} opacity={1} />
      <path d="M22 24v-2M26 26v-6M30 25v-4M34 24v-2" />
    </>
  ),
  diagrams: (
    <>
      <rect x="4" y="15" width="14" height="10" rx="2" />
      <path d="m32 12 8 8-8 8-8-8z" {...SHADE} />
      <path d="m32 12 8 8-8 8-8-8z" />
      <rect x="46" y="15" width="14" height="10" rx="2" />
      <path d="M18 20h5M40 20h5M32 28v6" />
    </>
  ),
  notion: (
    <>
      <rect x="8" y="5" width="48" height="30" rx="2" />
      <rect x="8" y="5" width="48" height="7" rx="2" {...SHADE} />
      <path d="M8 19h48M8 27h48M24 12v23" />
      <path d="M13 23h6M29 23h14M13 31h7M29 31h18" opacity={0.5} />
    </>
  ),
  'pull-requests': (
    <>
      <circle cx="20" cy="9" r="3" />
      <circle cx="20" cy="31" r="3" />
      <circle cx="44" cy="31" r="3" {...SHADE} opacity={1} />
      <path d="M20 12v16M44 28V16a4 4 0 0 0-4-4h-12m3-3-3 3 3 3" />
    </>
  ),
  slack: (
    <>
      <path d="M8 6h28a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H15l-5 4v-4H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" />
      <path d="M11 11h20M11 15h13" />
      <path d="M28 21h28a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-2v4l-5-4H28a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" {...SHADE} />
      <path d="M30 26h24M30 30h14" />
    </>
  ),
  themes: (
    <>
      <circle cx="20" cy="20" r="11" />
      <path d="M20 9a11 11 0 0 1 0 22z" {...SHADE} opacity={1} />
      <rect x="38" y="9" width="7" height="7" rx="1.5" {...SHADE} opacity={0.15} />
      <rect x="48" y="9" width="7" height="7" rx="1.5" {...SHADE} opacity={0.4} />
      <rect x="38" y="20" width="7" height="7" rx="1.5" {...SHADE} opacity={0.65} />
      <rect x="48" y="20" width="7" height="7" rx="1.5" {...SHADE} opacity={1} />
    </>
  ),
  'usage-limits': (
    <>
      <path d="M8 10h10M40 10h16" opacity={0.5} />
      <rect x="8" y="14" width="48" height="5" rx="2.5" />
      <rect x="8" y="14" width="34" height="5" rx="2.5" {...SHADE} opacity={1} />
      <rect x="8" y="27" width="48" height="5" rx="2.5" />
      <rect x="8" y="27" width="14" height="5" rx="2.5" {...SHADE} opacity={1} />
    </>
  )
}

/** A plugin's logo tile; an empty tile for a plugin without a drawing, so the rows stay aligned */
export const PluginPreview = ({ id }: { id: string }): React.JSX.Element => (
  <svg
    viewBox="0 0 64 40"
    aria-hidden
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-10 shrink-0 rounded-xl bg-muted p-1 text-muted-foreground ring-1 ring-border"
  >
    {DRAWINGS[id]}
  </svg>
)
