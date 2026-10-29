export type Mode = 'dark' | 'light'

/** The --term-* tokens live per data-mode in panes/terminal/terminal.css; the event tells open terminals to re-read them */
export function applyTheme(mode: Mode) {
  const root = document.documentElement
  const changed = root.dataset.mode !== mode
  root.dataset.mode = mode
  if (changed) window.dispatchEvent(new Event('treeix-theme'))
}

/** Under 1 the page goes see-through: the window's one fill takes the alpha (app.css), terminals get a clear canvas */
export function applyOpacity(opacity: number) {
  const root = document.documentElement
  const glass = opacity < 1
  root.style.setProperty('--app-alpha', `${Math.round(Math.min(1, Math.max(0.3, opacity)) * 100)}%`)
  if (glass === root.hasAttribute('data-glass')) return
  root.toggleAttribute('data-glass', glass)
  window.dispatchEvent(new Event('treeix-theme'))
}
