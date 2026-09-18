import { useEffect, useId, useState } from 'react'
import { activeTheme, useSettings } from '@treeix/app/settings'
import { Expandable } from '@treeix/app/Lightbox'
import { themeMode } from '@treeix/app/themes'

type MermaidApi = (typeof import('mermaid'))['default']
let mermaidReady: Promise<MermaidApi> | null = null

// Loaded on first diagram: mermaid is large and most comments have none
function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    return mermaid
  })
  return mermaidReady
}

let renderQueue: Promise<unknown> = Promise.resolve()

// mermaid.render shares global state, so parallel diagrams corrupt each other
function renderDiagram(id: string, code: string): Promise<string> {
  const result = renderQueue.then(() => loadMermaid()).then((mermaid) => {
    mermaid.initialize({ startOnLoad: false, theme: themeMode(activeTheme()) === 'light' ? 'default' : 'dark', securityLevel: 'strict', fontFamily: 'inherit' })
    return mermaid.render(id, code)
  })
  renderQueue = result.catch(() => undefined)
  return result.then(({ svg }) => svg)
}

export function Mermaid({ code }: { code: string }): React.JSX.Element {
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useSettings()
  const theme = activeTheme()

  useEffect(() => {
    let cancelled = false
    renderDiagram(id, code).then(
      (result) => !cancelled && setSvg(result),
      (reason: unknown) => !cancelled && setError(String(reason))
    )
    return () => {
      cancelled = true
    }
  }, [code, id, theme])

  if (error) {
    return (
      <>
        <span className="mb-2 block font-sans text-[11.5px] break-words whitespace-normal text-red-400 select-text">Diagram could not be rendered: {error}</span>
        <code>{code}</code>
      </>
    )
  }
  if (!svg) return <div className="py-4 text-xs text-muted-foreground">Rendering diagram...</div>
  // securityLevel strict makes mermaid sanitize labels, so the SVG is safe to inject
  const diagram = <div dangerouslySetInnerHTML={{ __html: svg }} />
  return (
    <Expandable title="Diagram" preview={<div className="my-3 flex justify-center overflow-x-auto">{diagram}</div>}>
      {diagram}
    </Expandable>
  )
}

