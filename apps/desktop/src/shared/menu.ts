/**
 * Which action section becomes which native menu, in menu bar order. The renderer filters the actions it sends
 * by this list and the main process groups them by it, so both sides have to read the same one.
 */
export const MENU_SECTIONS: [section: string, label: string][] = [
  ['Go to', 'Go'],
  ['Panels', 'View'],
  ['Terminal', 'Terminal']
]

/**
 * Reachable from the menu, but without its key beside it. macOS hands a menu key equivalent to the item before the
 * web contents sees the keydown, which would skip the app's filter that keeps the keyboard sheet out of text fields.
 */
export const NO_ACCELERATOR = new Set(['app.shortcuts'])

/** Runnable, but not menu material: the app menu already carries Settings, and the rest are second keys for one command */
export const NOT_IN_MENU = new Set(['app.settings', 'panel.listAlt', 'app.shortcutsBare'])
