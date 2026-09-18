import { type BrowserWindow, Menu, MenuItem } from 'electron'

/** macOS expects Settings in the app menu, next to About and Quit; the page opens its own settings tab */
export function addSettingsMenuItem(window: BrowserWindow): void {
  const menu = Menu.getApplicationMenu()
  // The first submenu is the app menu on macOS; on other platforms it's File, which is where Settings belongs too
  const appMenu = menu?.items[0]?.submenu
  if (!menu || !appMenu) return
  appMenu.insert(1, new MenuItem({ type: 'separator' }))
  appMenu.insert(1, new MenuItem({ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => window.webContents.send('open-settings') }))
  Menu.setApplicationMenu(menu)
}
