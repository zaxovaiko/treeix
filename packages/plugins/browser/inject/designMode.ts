import { ipcRenderer } from 'electron'
import { type Step, selectorFor } from './selector'

let outline: HTMLDivElement | null = null
let hovered: Element | null = null

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

const onClick = (event: MouseEvent): void => {
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
  ipcRenderer.sendToHost('selection', {
    selector,
    tag: target.tagName.toLowerCase(),
    text: (target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
    html: target.outerHTML.slice(0, 1024),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    url: location.href
  })
}

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
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
  } else if (!on && outline) {
    outline.remove()
    outline = null
    hovered = null
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
  }
}

export const listenForDesignMode = (): void => void ipcRenderer.on('design', (_, on: unknown) => setDesignMode(on === true))
