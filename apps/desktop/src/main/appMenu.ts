import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { toggleHotkeyWindow } from './hotkeyWindow'

/** One action the renderer offers the menu; `section` is the action's own, which decides the menu it lands in */
export type MenuAction = { id: string; label: string; section: string; accelerator?: string }

/** Which menu each action section becomes, in menu bar order */
const MENUS: [section: string, label: string][] = [
  ['Go to', 'Go'],
  ['Panels', 'View']
]

const isMac = process.platform === 'darwin'

/**
 * The menu bar, built from the actions the renderer says it can run. Electron's stock roles stay for the
 * editing and window commands; everything the app itself does arrives as data, so nothing is listed twice.
 */
export function buildMenu(window: BrowserWindow, actions: MenuAction[]): void {
  const run = (id: string) => (): void => window.webContents.send('run-action', id)
  const settings: MenuItemConstructorOptions[] = [
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => window.webContents.send('open-settings') },
    { type: 'separator' }
  ]
  // macOS expects Settings in the app menu next to About and Quit; everywhere else it belongs in File
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, ...settings, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
    : [{ label: 'File', submenu: [...settings, { role: 'quit' }] }]

  const fromActions = MENUS.flatMap(([section, label]): MenuItemConstructorOptions[] => {
    const items = actions.filter((action) => action.section === section)
    if (!items.length) return []
    return [{ label, submenu: items.map(({ id, label: item, accelerator }) => ({ label: item, accelerator, click: run(id) })) }]
  })

  const viewExtras: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { label: 'Toggle Hotkey Window', click: () => toggleHotkeyWindow(window) }]
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([...appMenu, { role: 'editMenu' }, ...fromActions, viewExtras]))
}
