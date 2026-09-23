export type ReactSource = { components: string[]; source: string | null }

/**
 * The React components around an element and where it is written, e.g. `src/Card.tsx:42`. Runs in the page's own world,
 * where React keeps its fibers on the DOM nodes, and is sent there as text, so it may use nothing from outside itself.
 * Only development builds carry this: `_debugSource` up to React 18, `_debugStack` from 19; a production page gives null.
 */
export function reactOf(element: Element | null): ReactSource | null {
  type Fiber = { type: unknown; return: Fiber | null; _debugSource?: { fileName: string; lineNumber: number }; _debugStack?: { stack?: string } }
  if (!element) return null
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!key) return null
  const nameOf = (type: unknown): string | null => {
    if (typeof type === 'function') return (type as { displayName?: string }).displayName || type.name || null
    if (typeof type !== 'object' || type === null) return null
    const wrapper = type as { displayName?: string; render?: unknown; type?: unknown }
    return wrapper.displayName ?? nameOf(wrapper.render ?? wrapper.type)
  }
  const placeOf = (fiber: Fiber): string | null => {
    if (fiber._debugSource) return `${fiber._debugSource.fileName}:${fiber._debugSource.lineNumber}`
    // The stack of the JSX call: the first frame outside React's own files is the component the element is written in
    for (const frame of fiber._debugStack?.stack?.split('\n').slice(1) ?? []) {
      const match = /([a-z-]+:\/\/\S+?):(\d+):\d+\)?$/.exec(frame.trim())
      if (!match || /node_modules|\/react(-dom)?[./_-]|jsx-(dev-)?runtime/.test(match[1])) continue
      try {
        return `${decodeURIComponent(new URL(match[1]).pathname).replace(/^\/(\.\/)?/, '')}:${match[2]}`
      } catch {
        continue
      }
    }
    return null
  }
  const components: string[] = []
  let source: string | null = null
  for (let fiber: Fiber | null = (element as unknown as Record<string, Fiber>)[key]; fiber && components.length < 6; fiber = fiber.return) {
    source ??= placeOf(fiber)
    const name = typeof fiber.type === 'string' ? null : nameOf(fiber.type)
    if (name && name !== components[0]) components.unshift(name)
  }
  return components.length || source ? { components, source } : null
}

export const isReactSource = (value: unknown): value is ReactSource => {
  const candidate = value as Partial<ReactSource> | null
  return !!candidate && Array.isArray(candidate.components) && candidate.components.every((name) => typeof name === 'string') && (candidate.source === null || typeof candidate.source === 'string')
}
