import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { session, webContents } from 'electron'
import { BROWSER_PARTITION } from '@treeix/host/webviewPolicy'
import type { MainPlugin } from '@treeix/sdk/main'
import type { ImportInfo } from '../shared/types'
import { importCookies } from './cookies/importer'
import { listProfiles, profileSource } from './cookies/profiles'
import { captureElement, responseBody, watchGuest } from './guests'
import { devServerCommand } from './devServer'

const isImportInfo = (value: unknown): value is ImportInfo =>
  value === null ||
  (typeof value === 'object' && 'browser' in value && typeof value.browser === 'string' && 'profile' in value && typeof value.profile === 'string' && 'at' in value && typeof value.at === 'number')

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('devServerCommand', (_, folder: string) => (typeof folder === 'string' ? devServerCommand(folder) : null))
    // Only pages embedded by the window asking may be wired, so one window can't reach another's pages
    context.handle('attach', (event, guestId: number) => {
      const guest = webContents.fromId(guestId)
      if (guest && guest.hostWebContents === event.sender) watchGuest(guest, context)
    })
    context.handle('responseBody', (event, guestId: number, requestId: string) => {
      const guest = webContents.fromId(guestId)
      return guest && guest.hostWebContents === event.sender ? responseBody(guest, requestId) : null
    })
    context.handle('capture', (event, guestId: number, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) => {
      const guest = webContents.fromId(guestId)
      return guest && guest.hostWebContents === event.sender ? captureElement(guest, rect, viewport) : null
    })
    // A dock id shows DevTools in the renderer's dock webview; without one they open in their own window, or close
    context.handle('devtools', (event, guestId: number, dockId: number | null) => {
      const guest = webContents.fromId(guestId)
      if (!guest || guest.hostWebContents !== event.sender) return
      if (dockId === null) {
        if (guest.isDevToolsOpened()) guest.closeDevTools()
        else guest.openDevTools({ mode: 'detach' })
        return
      }
      const dock = webContents.fromId(dockId)
      if (!dock || dock.hostWebContents !== event.sender) return
      if (guest.isDevToolsOpened()) guest.closeDevTools()
      guest.setDevToolsWebContents(dock)
      guest.openDevTools()
    })
    context.handle('closeDevtools', (event, guestId: number) => {
      const guest = webContents.fromId(guestId)
      if (guest && guest.hostWebContents === event.sender && guest.isDevToolsOpened()) guest.closeDevTools()
    })

    const infoPath = (): string => join(context.dataPath, 'import.json')
    // The App Store sandbox can't read other apps' files or Keychain items
    context.handle('canImport', () => !process.mas)
    context.handle('profiles', () => (process.mas ? [] : listProfiles()))
    context.handle('import', async (_, key: string) => {
      const source = await profileSource(key)
      const result = await importCookies(key, session.fromPartition(BROWSER_PARTITION))
      if (!result.error && source) {
        const info: ImportInfo = { browser: source.browser, profile: source.name, at: Date.now() }
        await writeFile(infoPath(), JSON.stringify(info))
      }
      return result
    })
    context.handle('importInfo', async (): Promise<ImportInfo> => {
      try {
        const info: unknown = JSON.parse(await readFile(infoPath(), 'utf8'))
        return isImportInfo(info) ? info : null
      } catch {
        return null
      }
    })
    context.handle('clearData', async () => {
      const browser = session.fromPartition(BROWSER_PARTITION)
      await browser.clearStorageData()
      await browser.clearCache()
      await writeFile(infoPath(), 'null')
    })
  }
}

export default plugin
