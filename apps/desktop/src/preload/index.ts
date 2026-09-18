import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Api } from '../shared/types'

const api: Api = {
  home: homedir(),
  scan: () => ipcRenderer.invoke('scan'),
  diff: (worktreePath) => ipcRenderer.invoke('diff', worktreePath),
  listFiles: (worktreePath) => ipcRenderer.invoke('listFiles', worktreePath),
  listDirectory: (root, folder) => ipcRenderer.invoke('listDirectory', root, folder),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  readFile: (worktreePath, filePath) => ipcRenderer.invoke('readFile', worktreePath, filePath),
  navigate: (worktreePath, kind, target) => ipcRenderer.invoke('navigate', worktreePath, kind, target),
  hover: (worktreePath, target) => ipcRenderer.invoke('hover', worktreePath, target),
  searchText: (worktreePaths, query, options) => ipcRenderer.invoke('searchText', worktreePaths, query, options),
  checkTools: () => ipcRenderer.invoke('checkTools'),
  plugins: {
    setEnabled: (ids) => ipcRenderer.invoke('plugins:setEnabled', ids),
    invoke: (pluginId, channel, ...args) => ipcRenderer.invoke(`plugin:${pluginId}:${channel}`, ...args),
    send: (pluginId, channel, ...args) => ipcRenderer.send(`plugin:${pluginId}:${channel}`, ...args),
    on: (pluginId, channel, listener) => {
      const handler = (_: IpcRendererEvent, ...args: unknown[]): void => listener(...args)
      ipcRenderer.on(`plugin:${pluginId}:${channel}`, handler)
      return () => ipcRenderer.removeListener(`plugin:${pluginId}:${channel}`, handler)
    }
  },
  showContextMenu: (items) => ipcRenderer.invoke('showContextMenu', items),
  addWorktree: (repoPath, branch, base) => ipcRenderer.invoke('addWorktree', repoPath, branch, base),
  listBranches: (repoPath) => ipcRenderer.invoke('listBranches', repoPath),
  createBranch: (repoPath, name, base) => ipcRenderer.invoke('createBranch', repoPath, name, base),
  deleteBranch: (repoPath, name) => ipcRenderer.invoke('deleteBranch', repoPath, name),
  removeWorktree: (worktreePath, force) => ipcRenderer.invoke('removeWorktree', worktreePath, force),
  discardChanges: (worktreePath, filePath) => ipcRenderer.invoke('discardChanges', worktreePath, filePath),
  revealInFinder: (path) => ipcRenderer.send('revealInFinder', path),
  openPath: (path) => ipcRenderer.send('openPath', path),
  setTranslucent: (translucent, background, appearance) => ipcRenderer.send('setTranslucent', translucent, background, appearance),
  configureHotkey: (options) => ipcRenderer.invoke('configureHotkey', options),
  onWindowChromeless: (listener) => {
    const handler = (_: IpcRendererEvent, chromeless: boolean): void => listener(chromeless)
    ipcRenderer.on('window-chromeless', handler)
    // The event only fires on changes, so a page reloaded in full screen asks for the current state first
    ipcRenderer.invoke('isChromeless').then((chromeless: unknown) => listener(chromeless === true))
    return () => ipcRenderer.removeListener('window-chromeless', handler)
  },
  onCloseShortcut: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('close-shortcut', handler)
    return () => ipcRenderer.removeListener('close-shortcut', handler)
  },
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('open-settings', handler)
    return () => ipcRenderer.removeListener('open-settings', handler)
  },
  saveAttachment: (name, data) => ipcRenderer.invoke('saveAttachment', name, data),
  saveFile: (worktreePath, filePath, contents, expected) => ipcRenderer.invoke('saveFile', worktreePath, filePath, contents, expected),
  watchFile: (worktreePath, filePath, listener) => {
    const id = randomUUID()
    const handler = (_: IpcRendererEvent, changedId: string): void => {
      if (changedId === id) listener()
    }
    ipcRenderer.on('file-changed', handler)
    ipcRenderer.send('watchFile', id, worktreePath, filePath)
    return () => {
      ipcRenderer.removeListener('file-changed', handler)
      ipcRenderer.send('unwatchFile', id)
    }
  },
  listHistory: (worktreePath, filePath) => ipcRenderer.invoke('listHistory', worktreePath, filePath),
  readHistory: (worktreePath, filePath, id) => ipcRenderer.invoke('readHistory', worktreePath, filePath, id),
  createPath: (worktreePath, filePath) => ipcRenderer.invoke('createPath', worktreePath, filePath),
  renamePath: (worktreePath, from, to) => ipcRenderer.invoke('renamePath', worktreePath, from, to),
  trashPath: (worktreePath, filePath) => ipcRenderer.invoke('trashPath', worktreePath, filePath),
}

contextBridge.exposeInMainWorld('api', api)
