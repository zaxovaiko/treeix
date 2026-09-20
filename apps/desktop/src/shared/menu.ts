/**
 * Which action section becomes which native menu, in menu bar order. The renderer filters the actions it sends
 * by this list and the main process groups them by it, so both sides have to read the same one.
 */
export const MENU_SECTIONS: [section: string, label: string][] = [
  ['Go to', 'Go'],
  ['Panels', 'View']
]

/**
 * Reachable from the menu, but without their key beside them. macOS hands a menu key equivalent to the item
 * before the web contents sees the keydown, which would skip the context filters these two have in `useShellKeys`:
 * zen stays out of text fields, and so does the keyboard sheet.
 */
export const NO_ACCELERATOR = new Set(['shell.zen', 'app.shortcuts'])

/** Runnable, but not menu material: the app menu already carries Settings, and the rest are second keys for one command */
export const NOT_IN_MENU = new Set(['app.settings', 'app.paletteAlt'])
