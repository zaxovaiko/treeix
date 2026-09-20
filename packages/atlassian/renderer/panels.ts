import type { usePanels } from '@treeix/sdk'

/**
 * Puts the list on screen, then runs `then`: leaves zen mode, and shows the list if it was hidden. Never hides it,
 * which toggling alone would do in zen mode, where the list is set to show but isn't drawn. `marker` is an element id
 * inside the list, to tell whether it is on screen.
 */
export function withList(panels: ReturnType<typeof usePanels>, marker: string, then: () => void): void {
  if (panels.list) return then()
  if (panels.zen) panels.toggleZen()
  requestAnimationFrame(() => {
    if (!document.getElementById(marker)) panels.toggle('list')
    requestAnimationFrame(then)
  })
}
