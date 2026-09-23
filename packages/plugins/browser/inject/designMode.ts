import { ipcRenderer, webFrame } from 'electron'
import { isReactSource, reactOf, type ReactSource } from './react'
import { sourceOf } from './sourceMap'
import { type Step, selectorFor } from './selector'

let outline: HTMLDivElement | null = null
let hovered: Element | null = null
/** Set on the picked element for the page's own world to find it; attributes are the one thing both worlds see */
const PICKED = 'data-treeix-picked'

function stepsOf(element: Element): Step[] {
  const steps: Step[] = []
  for (let node: Element | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const same = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node?.tagName) : [node]
    steps.push({ tag: node.tagName.toLowerCase(), id: node.id, nth: same.indexOf(node) + 1, sameTagSiblings: same.length })
  }
  return steps
}

const unique = (selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function draw(element: Element | null): void {
  if (!outline) return
  if (!element) {
    outline.style.display = 'none'
    return
  }
  const rect = element.getBoundingClientRect()
  Object.assign(outline.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
}

const onMove = (event: MouseEvent): void => {
  const target = document.elementFromPoint(event.clientX, event.clientY)
  if (target && target !== outline && target !== hovered) {
    hovered = target
    draw(target)
  }
}

const onClick = async (event: MouseEvent): Promise<void> => {
  event.preventDefault()
  event.stopPropagation()
  const target = event.altKey ? (hovered?.parentElement ?? hovered) : hovered
  if (!target) return
  hovered = target
  draw(target)
  const rect = target.getBoundingClientRect()
  const steps = stepsOf(target)
  // body/html climb out of stepsOf's range and produce no steps; their tag alone is already a usable selector
  const selector = steps.length ? selectorFor(steps, unique) : target.tagName.toLowerCase()
  const html = target.outerHTML.slice(0, 1024)
  target.setAttribute(PICKED, '')
  const found: unknown = await webFrame.executeJavaScript(`(${reactOf})(document.querySelector('[${PICKED}]'))`).catch(() => null)
  target.removeAttribute(PICKED)
  const react = isReactSource(found) ? await withOriginalSource(found) : null
  ipcRenderer.sendToHost('selection', {
    selector,
    tag: target.tagName.toLowerCase(),
    text: (target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
    html,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    url: location.href,
    ...(react ? { react } : {})
  })
}

/** Bundlers like Turbopack serve chunks, so the stack's file and line go through the page's source map when it has one */
async function withOriginalSource({ frame, ...react }: ReactSource): Promise<ReactSource> {
  const source = frame ? await sourceOf(frame).catch(() => null) : null
  return source ? { ...react, source } : react
}

const clickListener = (event: MouseEvent): void => void onClick(event)

const onKey = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  ipcRenderer.sendToHost('design-exit')
}

function setDesignMode(on: boolean): void {
  if (on && !outline) {
    outline = document.createElement('div')
    Object.assign(outline.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', outline: '2px solid #3b82f6', background: 'rgb(59 130 246 / 0.08)', display: 'none' })
    document.documentElement.append(outline)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', clickListener, true)
    document.addEventListener('keydown', onKey, true)
  } else if (!on && outline) {
    outline.remove()
    outline = null
    hovered = null
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', clickListener, true)
    document.removeEventListener('keydown', onKey, true)
  }
}

export const listenForDesignMode = (): void => void ipcRenderer.on('design', (_, on: unknown) => setDesignMode(on === true))
