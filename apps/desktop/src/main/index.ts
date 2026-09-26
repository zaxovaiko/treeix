import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { CodePosition, ContextMenuItem, HotkeyOptions, NavigationKind, SearchOptions, SymbolTarget } from '../shared/types'
import { saveAttachment } from './attachments'
import { migrateUserData } from './userData'
import { createPath, listDirectory, renamePath, saveFile, stopWatching, trashPath, watchFile } from './files'
import { createHistory } from './history'
import { enableTextMenu, showContextMenu } from './contextMenu'
import { addWorktree, createBranch, deleteBranch, diff, listBranches, discardChanges, listFiles, searchText, readFile, readImage, removeWorktree, scan } from './git'
import { buildMenu, type MenuAction } from './appMenu'
import { configureHotkey, isSummoned, releaseHotkey } from './hotkeyWindow'
import { closeDocument, completionDetails, completions, diagnostics, hover, navigate, signatureHelp, stopLanguageProcess } from './language'
import { disposePlugins, enabledTools, setEnabledPlugins } from './plugins'
import { loadShellPath } from './env'
import { checkTools, commandExists } from './tools'
import { setupUpdates } from './updates'
import { BROWSER_PARTITION, configureBrowserSession, hardenWebview } from './webviewPolicy'

app.setAboutPanelOptions({ applicationName: 'Treeix', applicationVersion: __APP_VERSION__, version: '', copyright: 'Apache 2.0' })

// Apps launched from Finder get a minimal PATH: Homebrew now, the user's full shell PATH once it has loaded
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':')
const shellPath = loadShellPath()

app.setName('Treeix')
// TREEIX_USER_DATA or --user-data-dir runs a separate profile, e.g. for demo screenshots
if (process.env.TREEIX_USER_DATA) app.setPath('userData', process.env.TREEIX_USER_DATA)
else if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = join(app.getPath('appData'), 'Treeix')
  app.setPath('userData', migrateUserData(join(app.getPath('appData'), 'quick-diff'), userData))
}

// TREEIX_HEADLESS keeps the window hidden and out of the Dock, e.g. for e2e runs that shouldn't take over the screen
const headless = process.env.TREEIX_HEADLESS === '1'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'Treeix',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    // Keep the blur when the window loses focus instead of flattening to grey
    visualEffectState: 'active',
    // macOS otherwise spends the first click on an inactive window just focusing it, so the palette button needed two
    acceptFirstMouse: true,
    // A never-shown window would otherwise be throttled like a background one
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, webviewTag: true, backgroundThrottling: !headless }
  })
  if (!headless) window.on('ready-to-show', () => window.show())
  enableTextMenu(window.webContents)
  // The built-in browser's pages: our isolation and preload whatever the renderer asked for
  window.webContents.on('will-attach-webview', (_, prefs) => hardenWebview(prefs, join(__dirname, '../preload/browserInject.js')))
  buildMenu(window, [])
  // ⌘W closes the focused terminal pane when there is one; the page decides and closes the window otherwise
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.shift || input.alt || input.control || input.code !== 'KeyW') return
    event.preventDefault()
    window.webContents.send('close-shortcut')
  })
  // macOS full screen hides the traffic lights, so the title bar can drop the space it keeps for them
  window.on('enter-full-screen', () => window.webContents.send('window-chromeless', true))
  window.on('leave-full-screen', () => window.webContents.send('window-chromeless', false))
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  if (headless && process.platform === 'darwin') app.setActivationPolicy('accessory')
  // Packaged builds take the icon from the bundle; dev runs inside the stock Electron app
  if (is.dev) app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  configureBrowserSession(session.fromPartition(BROWSER_PARTITION), app.userAgentFallback, app.getName())
  ipcMain.handle('scan', () => scan())
  ipcMain.handle('diff', (_, worktreePath: string) => diff(worktreePath))
  ipcMain.handle('listFiles', (_, worktreePath: string) => listFiles(worktreePath))
  ipcMain.handle('isChromeless', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window !== null && (window.isFullScreen() || isSummoned())
  })
  ipcMain.handle('listDirectory', (_, root: string, folder: string) => listDirectory(root, folder))
  // ⌘= ⌘+ ⌘- ⌘0: the window's own zoom, like a browser's. The native menu's roles only bind some of these keys
  ipcMain.on('zoom', (event, step: number) => {
    const level = step === 0 ? 0 : Math.max(-3, Math.min(6, event.sender.getZoomLevel() + Math.sign(step) * 0.5))
    event.sender.setZoomLevel(level)
  })
  ipcMain.handle('pickFolder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const { canceled, filePaths } = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
    return canceled ? null : (filePaths[0] ?? null)
  })
  ipcMain.handle('readFile', (_, worktreePath: string, filePath: string) => readFile(worktreePath, filePath))
  ipcMain.handle('readImage', (_, worktreePath: string, filePath: string) => readImage(worktreePath, filePath).catch(() => null))
  ipcMain.handle('navigate', (_, worktreePath: string, kind: NavigationKind, target: SymbolTarget) => navigate(worktreePath, kind, target))
  ipcMain.handle('searchText', (_, worktreePaths: string[], query: string, options: SearchOptions) => searchText(worktreePaths, query, options))
  ipcMain.handle('hover', (_, worktreePath: string, target: SymbolTarget) => hover(worktreePath, target))
  ipcMain.handle('completions', (_, worktreePath: string, path: string, text: string, position: CodePosition) => completions(worktreePath, path, text, position))
  ipcMain.handle('completionDetails', (_, worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null) =>
    completionDetails(worktreePath, path, text, position, name, source, data)
  )
  ipcMain.handle('signatureHelp', (_, worktreePath: string, path: string, text: string, position: CodePosition) => signatureHelp(worktreePath, path, text, position))
  ipcMain.handle('diagnostics', (_, worktreePath: string, path: string, text: string) => diagnostics(worktreePath, path, text))
  ipcMain.on('closeDocument', (_, worktreePath: string, path: string) => closeDocument(worktreePath, path))
  ipcMain.handle('checkTools', () => checkTools(enabledTools()))
  ipcMain.handle('commandExists', async (_, name: unknown) => (await shellPath, typeof name === 'string' ? commandExists(name) : false))
  ipcMain.handle('plugins:setEnabled', (_, ids: string[]) => setEnabledPlugins(ids, app.getPath('userData')))
  ipcMain.handle('configureHotkey', (event, options: HotkeyOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? configureHotkey(window, options) : 'No window'
  })
  ipcMain.handle('showContextMenu', (event, items: ContextMenuItem[]) => showContextMenu(event.sender, items))
  ipcMain.handle('addWorktree', (_, repoPath: string, branch: string, base?: string) => addWorktree(repoPath, branch, base))
  ipcMain.handle('listBranches', (_, repoPath: string) => listBranches(repoPath))
  ipcMain.handle('createBranch', (_, repoPath: string, name: string, base: string) => createBranch(repoPath, name, base))
  ipcMain.handle('deleteBranch', (_, repoPath: string, name: string) => deleteBranch(repoPath, name))
  ipcMain.handle('removeWorktree', (_, worktreePath: string, force: boolean) => removeWorktree(worktreePath, force))
  ipcMain.handle('discardChanges', (_, worktreePath: string, filePath: string) => discardChanges(worktreePath, filePath))
  ipcMain.on('setMenuActions', (event, actions: MenuAction[]) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) buildMenu(window, actions)
  })
  ipcMain.on('revealInFinder', (_, path: string) => shell.showItemInFolder(path))
  ipcMain.on('openPath', (_, path: string) => void shell.openPath(path))
  ipcMain.on('setTranslucent', (event, translucent: boolean, background: string, appearance: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    // Vibrancy tints by the app appearance, which otherwise follows macOS: a dark theme on a light Mac got light, washed-out glass
    if (appearance === 'dark' || appearance === 'light' || appearance === 'system') nativeTheme.themeSource = appearance
    // The page paints its own backgrounds with reduced alpha; vibrancy supplies the blurred desktop underneath
    window?.setVibrancy(translucent ? 'under-window' : null)
    // Opaque windows show this wherever Chromium hasn't painted yet (fast scrolling), so it follows the theme
    window?.setBackgroundColor(translucent ? '#00000000' : /^#[0-9a-f]{6}$/i.test(background) ? background : '#0a0a0a')
  })
  ipcMain.handle('saveAttachment', (_, name: string, data: Uint8Array) => saveAttachment(name, data))
  const history = createHistory(join(app.getPath('userData'), 'history'))
  ipcMain.handle('saveFile', async (_, worktreePath: string, filePath: string, contents: string, expected: string | null) => {
    await history.snapshotBeforeSave(worktreePath, filePath).catch(() => undefined)
    await saveFile(worktreePath, filePath, contents, expected)
  })
  ipcMain.on('watchFile', (event, id: string, worktreePath: string, filePath: string) => watchFile(event.sender, id, worktreePath, filePath))
  ipcMain.on('unwatchFile', (_, id: string) => stopWatching(id))
  ipcMain.handle('listHistory', (_, worktreePath: string, filePath: string) => history.list(worktreePath, filePath))
  ipcMain.handle('readHistory', (_, worktreePath: string, filePath: string, id: string) => history.read(worktreePath, filePath, id))
  ipcMain.handle('createPath', (_, worktreePath: string, filePath: string) => createPath(worktreePath, filePath))
  ipcMain.handle('renamePath', (_, worktreePath: string, from: string, to: string) => renamePath(worktreePath, from, to))
  ipcMain.handle('trashPath', (_, worktreePath: string, filePath: string) => trashPath(worktreePath, filePath))
  setupUpdates()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', disposePlugins)
app.on('will-quit', () => {
  releaseHotkey()
  stopLanguageProcess()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
