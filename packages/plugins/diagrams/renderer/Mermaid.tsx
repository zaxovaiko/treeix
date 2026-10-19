import { useEffect, useId, useState } from 'react'
import { activeTheme, activeThemeId, useSettings } from '@treeix/app/settings'
import { Expandable } from '@treeix/app/Lightbox'

type MermaidApi = (typeof import('mermaid'))['default']
let mermaidReady: Promise<MermaidApi> | null = null

// Loaded on first diagram: mermaid is large and most comments have none
function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    return mermaid
  })
  return mermaidReady
}

/** Mermaid's base theme derives every diagram color from these, so diagrams take the app theme's surfaces and accent */
function themeVariables(): Record<string, string | boolean> {
  const { mode, background, card, popover, foreground, mutedForeground, primary } = activeTheme()
  return {
    darkMode: mode === 'dark',
    background,
    // Nodes sit a step off the page: light themes lift the card, dark ones the popover
    primaryColor: popover !== background ? popover : card,
    primaryTextColor: foreground,
    primaryBorderColor: primary,
    secondaryColor: card,
    tertiaryColor: card,
    lineColor: mutedForeground,
    textColor: foreground
  }
}

let renderQueue: Promise<unknown> = Promise.resolve()

// mermaid.render shares global state, so parallel diagrams corrupt each other
function renderDiagram(id: string, code: string): Promise<string> {
  const result = renderQueue
    .then(() => loadMermaid())
    .then((mermaid) => {
      mermaid.initialize({ startOnLoad: false, theme: 'base', look: 'classic', layout: 'dagre', themeVariables: themeVariables(), securityLevel: 'strict', fontFamily: 'inherit' })
      return mermaid.render(id, code)
    })
  renderQueue = result.catch(() => undefined)
  return result.then(({ svg }) => svg)
}

// Rendered diagrams by theme and source, so a remount (a parent's rerender, scrolling back) shows one at once
// ponytail: never evicted, a session renders few diagrams
const rendered = new Map<string, string>()

export function Mermaid({ code }: { code: string }): React.JSX.Element {
  'use no memo' // the active theme is read from settings during render
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const [, setDone] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useSettings()
  const key = `${activeThemeId()}\n${code}`
  const svg = rendered.get(key) ?? null

  useEffect(() => {
    if (rendered.has(key)) return
    let cancelled = false
    renderDiagram(id, code).then(
      (result) => {
        rendered.set(key, result)
        if (!cancelled) setDone((count) => count + 1)
      },
      (reason: unknown) => !cancelled && setError(String(reason))
    )
    return () => {
      cancelled = true
    }
  }, [key, id])

  if (error) {
    return (
      <>
        <span className="mb-2 block font-sans text-[11.5px] break-words whitespace-normal text-red-400 select-text">Diagram could not be rendered: {error}</span>
        <code>{code}</code>
      </>
    )
  }
  if (!svg) {
    return (
      <div role="status" className="my-3 grid h-32 place-items-center rounded-xl bg-foreground/5 font-sans text-xs text-muted-foreground">
        <span className="shimmer">Rendering diagram…</span>
      </div>
    )
  }
  // securityLevel strict makes mermaid sanitize labels, so the SVG is safe to inject
  const diagram = <div dangerouslySetInnerHTML={{ __html: svg }} />
  return (
    <Expandable title="Diagram" preview={<div className="my-3 flex justify-center overflow-x-auto">{diagram}</div>}>
      {diagram}
    </Expandable>
  )
}
