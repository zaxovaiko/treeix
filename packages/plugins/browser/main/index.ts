import { writeFile } from 'node:fs/promises'
import { readJsonFile } from '@treeix/host/paths'
import { join } from 'node:path'
import { type IpcMainInvokeEvent, session, type WebContents, webContents } from 'electron'
import { BROWSER_PARTITION } from '@treeix/host/webviewPolicy'
import type { MainPlugin } from '@treeix/sdk/main'
import type { ImportInfo } from '../shared/types'
import { importCookies } from './cookies/importer'
import { listProfiles, profileSource } from './cookies/profiles'
import { browserTools, registerTab } from './agentTools'
import { captureElement, responseBody, watchGuest } from './guests'
import { devServerCommand } from './devServer'

const isImportInfo = (value: unknown): value is ImportInfo =>
  value === null ||
  (typeof value === 'object' &&
    'browser' in value &&
    typeof value.browser === 'string' &&
    'profile' in value &&
    typeof value.profile === 'string' &&
    'at' in value &&
    typeof value.at === 'number')

/** Only pages embedded by the window asking may be reached, so one window can't reach another's pages */
function ownGuest(event: IpcMainInvokeEvent, guestId: number): WebContents | null {
  const guest = webContents.fromId(guestId)
  return guest && guest.hostWebContents === event.sender ? guest : null
}

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('devServerCommand', (_, folder: string) => (typeof folder === 'string' ? devServerCommand(folder) : null))
    context.handle('attach', (event, guestId: number, tabId: unknown) => {
      const guest = ownGuest(event, guestId)
      if (!guest) return
      watchGuest(guest, context)
      if (typeof tabId === 'string') registerTab(tabId, guest)
    })
    browserTools(context).forEach(context.mcpTool)
    context.handle('responseBody', (event, guestId: number, requestId: string) => {
      const guest = ownGuest(event, guestId)
      return guest && responseBody(guest, requestId)
    })
    context.handle('capture', (event, guestId: number, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) => {
      const guest = ownGuest(event, guestId)
      return guest && captureElement(guest, rect, viewport)
    })
    context.handle('devtools', (event, guestId: number) => {
      const guest = ownGuest(event, guestId)
      if (!guest) return
      if (guest.isDevToolsOpened()) guest.closeDevTools()
      else guest.openDevTools({ mode: 'detach' })
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
      const info = await readJsonFile(infoPath())
      return isImportInfo(info) ? info : null
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
