import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { ContextMenuItem } from '../shared/types'

/** Pops a native menu and resolves with the chosen item id, or null when dismissed */
export function showContextMenu(sender: WebContents, items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    const template: MenuItemConstructorOptions[] = items.map((item) =>
      item.type === 'separator'
        ? { type: 'separator' }
        : {
            label: item.label,
            enabled: item.enabled ?? true,
            accelerator: item.accelerator,
            registerAccelerator: false,
            click: () => resolve(item.id)
          }
    )
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(sender) ?? undefined,
      // Fires on close too; a click resolves first, so this only settles dismissals
      callback: () => setTimeout(() => resolve(null), 50)
    })
  })
}

/** Copy and paste for inputs and selected text anywhere the app has no menu of its own */
export function enableTextMenu(contents: WebContents): void {
  contents.on('context-menu', (_, { isEditable, selectionText }) => {
    if (!isEditable && !selectionText) return
    const template: MenuItemConstructorOptions[] = isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : [{ role: 'copy' }]
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
  })
}
