import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Icon } from '../icons'

// Copied from the Electron diagrams plugin; colors come from the CSS theme variables instead of settings

type MermaidApi = (typeof import('mermaid'))['default']
let mermaidReady: Promise<MermaidApi> | null = null

// Loaded on the first diagram: mermaid is large and most plans have none
const loadMermaid = (): Promise<MermaidApi> => (mermaidReady ??= import('mermaid').then(({ default: mermaid }) => mermaid))

const subscribeMode = (listener: () => void) => {
  window.addEventListener('treeix-theme', listener)
  return () => window.removeEventListener('treeix-theme', listener)
}
const currentMode = (): string => document.documentElement.dataset.mode ?? 'dark'

/** Mermaid's base theme derives every diagram color from these, so diagrams take the app's surfaces and accent */
function themeVariables(): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement)
  const color = (name: string) => css.getPropertyValue(name).trim()
  return {
    darkMode: currentMode() === 'dark',
    background: color('--background'),
    primaryColor: color('--popover'),
    primaryTextColor: color('--foreground'),
    primaryBorderColor: color('--primary'),
    secondaryColor: color('--muted'),
    tertiaryColor: color('--muted'),
    lineColor: color('--muted-foreground'),
    textColor: color('--foreground'),
    edgeLabelBackground: color('--background'),
  }
}

let renderQueue: Promise<unknown> = Promise.resolve()

// mermaid.render shares global state, so parallel diagrams corrupt each other
function renderDiagram(id: string, code: string): Promise<string> {
  const result = renderQueue
    .then(loadMermaid)
    .then((mermaid) => {
      mermaid.initialize({ startOnLoad: false, theme: 'base', look: 'classic', layout: 'dagre', themeVariables: themeVariables(), securityLevel: 'strict', fontFamily: 'inherit' })
      return mermaid.render(id, code)
    })
  renderQueue = result.catch(() => undefined)
  return result.then(({ svg }) => svg)
}

// Rendered diagrams by mode and source, so a remount shows one at once
// ponytail: never evicted, a session renders few diagrams
const rendered = new Map<string, string>()

export function Mermaid({ code, title = 'Diagram' }: { code: string; title?: string }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const mode = useSyncExternalStore(subscribeMode, currentMode)
  const key = `${mode}\n${code}`
  // The svg is state, not a read of `rendered` during render, so the React Compiler sees it change
  const [svg, setSvg] = useState<{ key: string; svg: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const shown = svg?.key === key ? svg.svg : (rendered.get(key) ?? null)

  useEffect(() => {
    const cached = rendered.get(key)
    if (cached) return setSvg({ key, svg: cached })
    let cancelled = false
    setError(null)
    renderDiagram(id, code).then(
      (result) => {
        rendered.set(key, result)
        if (!cancelled) setSvg({ key, svg: result })
      },
      (reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)),
    )
    return () => {
      cancelled = true
    }
  }, [key, id, code])

  if (error)
    return (
      <div className="mmderr">
        <div>Diagram could not be rendered: {error}</div>
        <pre className="mono">{code}</pre>
      </div>
    )
  if (!shown) return <div className="mmdwait" role="status">Rendering diagram...</div>
  // securityLevel strict makes mermaid sanitize labels, so the SVG is safe to inject
  const diagram = <div className="mmd" dangerouslySetInnerHTML={{ __html: shown }} />
  return (
    <>
      <button className="mmdbox" title="Zoom" onClick={() => setOpen(true)}>
        {diagram}
      </button>
      {open && <Lightbox title={title} onClose={() => setOpen(false)}>{diagram}</Lightbox>}
    </>
  )
}

/** The diagram over the window with zoom; Esc or a click outside closes */
function Lightbox({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="lbox" role="dialog" aria-label={title}>
        <div className="lbar">
          <span className="grow">{title}</span>
          <button className="btn sm ghost" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>-</button>
          <span className="dim mono">{Math.round(zoom * 100)}%</span>
          <button className="btn sm ghost" title="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
            <Icon name="plus" />
          </button>
          <button className="icon sm" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="limg" style={{ '--z': zoom } as React.CSSProperties}>
          {children}
        </div>
      </div>
    </>
  )
}
