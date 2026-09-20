import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

/** Checked once shortly after launch, then on this interval while the app stays open */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 10_000

let status: UpdateStatus = { current: __APP_VERSION__, phase: 'idle' }

function publish(next: Omit<UpdateStatus, 'current'>): void {
  status = { current: __APP_VERSION__, ...next }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('updates:status', status)
}

/**
 * Updates come from the GitHub release the tag published, downloaded in the background; the page offers the
 * restart. Builds that update elsewhere (dev runs, the Mac App Store) say so instead of pretending to check.
 */
export function setupUpdates(): void {
  ipcMain.handle('updates:status', () => status)
  ipcMain.on('updates:install', () => {
    if (status.phase === 'ready') autoUpdater.quitAndInstall()
  })

  const unsupported =
    !app.isPackaged ? 'Updates are for packaged builds; this is a development run'
    : process.mas ? 'The Mac App Store delivers updates for this build'
    : null
  if (unsupported) {
    publish({ phase: 'unsupported', message: unsupported })
    ipcMain.handle('updates:check', () => status)
    return
  }

  // The page drives the restart, so nothing is installed behind the user's back
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => publish({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) => publish({ phase: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => publish({ phase: 'idle' }))
  autoUpdater.on('download-progress', (progress) => publish({ phase: 'downloading', version: status.version, percent: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => publish({ phase: 'ready', version: info.version }))
  // An unreachable GitHub or a build macOS refuses to replace, e.g. one signed ad-hoc
  autoUpdater.on('error', (error) => publish({ phase: 'error', message: error.message }))

  const check = async (): Promise<UpdateStatus> => {
    // A download in flight or waiting to install: checking again would restart it
    if (status.phase === 'downloading' || status.phase === 'ready') return status
    await autoUpdater.checkForUpdates().catch((error: unknown) => publish({ phase: 'error', message: error instanceof Error ? error.message : String(error) }))
    return status
  }
  ipcMain.handle('updates:check', () => check())
  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_INTERVAL_MS)
}
