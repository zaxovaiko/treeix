import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { MENU_SECTIONS } from '../shared/menu'
import { toggleHotkeyWindow } from './hotkeyWindow'

/** One action the renderer offers the menu; `section` is the action's own, which decides the menu it lands in */
export type MenuAction = { id: string; label: string; section: string; accelerator?: string }

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

  const fromActions = MENU_SECTIONS.flatMap(([section, label]): MenuItemConstructorOptions[] => {
    const items = actions.filter((action) => action.section === section)
    if (!items.length) return []
    return [{ label, submenu: items.map(({ id, label: item, accelerator }) => ({ label: item, accelerator, click: run(id) })) }]
  })

  // The window commands keep their roles, which is what gives macOS its window list and Bring All to Front
  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ role: 'front' as const }] : []),
      { type: 'separator' },
      { label: 'Toggle Hotkey Window', click: () => toggleHotkeyWindow(window) }
    ]
  }
  const viewExtras: MenuItemConstructorOptions[] = [
    { type: 'separator' },
    { role: 'togglefullscreen' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' }
  ]
  // The panels menu is the app's own View, so the stock view commands join it rather than starting a second one
  const withExtras = fromActions.map((menu) => (menu.label === 'View' ? { ...menu, submenu: [...(menu.submenu as MenuItemConstructorOptions[]), ...viewExtras] } : menu))
  const view: MenuItemConstructorOptions[] = withExtras.some((menu) => menu.label === 'View') ? withExtras : [...withExtras, { label: 'View', submenu: viewExtras.slice(1) }]

  Menu.setApplicationMenu(Menu.buildFromTemplate([...appMenu, { role: 'editMenu' }, ...view, windowMenu]))
}
