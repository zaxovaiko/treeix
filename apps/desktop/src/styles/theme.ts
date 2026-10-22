export type Mode = 'dark' | 'light'
export type UiMode = 'compact' | 'islands'

/** The --term-* tokens live per data-mode in panes/terminal/terminal.css; the event tells open terminals to re-read them */
export function applyTheme(mode: Mode, ui: UiMode) {
  const root = document.documentElement
  const changed = root.dataset.mode !== mode
  root.dataset.mode = mode
  root.dataset.ui = ui
  if (changed) window.dispatchEvent(new Event('treeix-theme'))
}
