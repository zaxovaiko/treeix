import { type BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents, webContents } from 'electron'
import { MENU_SECTIONS } from '../shared/menu'
import { toggleHotkeyWindow } from './hotkeyWindow'

/** One action the renderer offers the menu; `section` is the action's own, which decides the menu it lands in */
export type MenuAction = { id: string; label: string; section: string; accelerator?: string }

const isMac = process.platform === 'darwin'

/** A page of the built-in browser holding keyboard focus, which ⌘R and ⌥⌘I should act on instead of the app */
const focusedPage = (): WebContents | undefined => {
  const focused = webContents.getFocusedWebContents()
  return focused?.getType() === 'webview' ? focused : undefined
}

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
  // The zoom keys run the app's own actions rather than Electron's roles, whose accelerators miss ⌘= and ⌘+
  const zoom = (id: string, label: string, accelerator: string, visible = true): MenuItemConstructorOptions => ({ label, accelerator, visible, click: run(id) })
  const viewExtras: MenuItemConstructorOptions[] = [
    { type: 'separator' },
    { role: 'togglefullscreen' },
    zoom('app.zoomReset', 'Actual Size', 'CmdOrCtrl+0'),
    zoom('app.zoomIn', 'Zoom In', 'CmdOrCtrl+='),
    zoom('app.zoomIn', 'Zoom In', 'Shift+CmdOrCtrl+=', false),
    zoom('app.zoomOut', 'Zoom Out', 'CmdOrCtrl+-'),
    { type: 'separator' },
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => (focusedPage() ?? window.webContents).reload() },
    { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => (focusedPage() ?? window.webContents).reloadIgnoringCache() },
    { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => (focusedPage() ?? window.webContents).toggleDevTools() },
  ]
  // The panels menu is the app's own View, so the stock view commands join it rather than starting a second one
  const withExtras = fromActions.map((menu) => (menu.label === 'View' ? { ...menu, submenu: [...(menu.submenu as MenuItemConstructorOptions[]), ...viewExtras] } : menu))
  const view: MenuItemConstructorOptions[] = withExtras.some((menu) => menu.label === 'View') ? withExtras : [...withExtras, { label: 'View', submenu: viewExtras.slice(1) }]

  Menu.setApplicationMenu(Menu.buildFromTemplate([...appMenu, { role: 'editMenu' }, ...view, windowMenu]))
}
