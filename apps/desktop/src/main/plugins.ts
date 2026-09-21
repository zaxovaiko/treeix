import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatAdapter, MainContext, MainPlugin, ToolDefinition } from '@treeix/sdk/main'
import { adaptersOf } from './pluginAdapters'

const modules = import.meta.glob<MainPlugin>('../../../../packages/plugins/*/main/index.ts', { eager: true, import: 'default' })
const pluginIdOf = (path: string): string => path.split('/').at(-3) ?? path

/** Every plugin with a main module, by the folder name, which matches its manifest id */
const MAIN_PLUGINS = new Map(Object.entries(modules).map(([path, plugin]) => [pluginIdOf(path), plugin]))

const channelOf = (pluginId: string, channel: string): string => `plugin:${pluginId}:${channel}`

const active = new Map<string, { dispose: () => void }>()

export function sessionEnv(): Promise<Record<string, string>> {
  const sources = [...active.keys()].flatMap((id) => MAIN_PLUGINS.get(id)?.sessionEnv ?? [])
  return Promise.all(sources.map((source) => source().catch(() => ({})))).then((parts) => Object.assign({}, ...parts))
}

function activate(pluginId: string, plugin: MainPlugin, userData: string): { dispose: () => void } {
  const disposers: (() => void)[] = []
  const dataPath = join(userData, 'plugins', pluginId)
  const context: MainContext = {
    handle: <Args extends unknown[]>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown) => {
      const name = channelOf(pluginId, channel)
      // Arguments come from the app's own renderer, like every other IPC handler here
      ipcMain.handle(name, (event, ...args) => handler(event, ...(args as Args)))
      disposers.push(() => ipcMain.removeHandler(name))
    },
    on: <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) => {
      const name = channelOf(pluginId, channel)
      const handler = (event: IpcMainEvent, ...args: unknown[]): void => listener(event, ...(args as Args))
      ipcMain.on(name, handler)
      disposers.push(() => ipcMain.removeListener(name, handler))
    },
    broadcast: (channel, ...args) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channelOf(pluginId, channel), ...args)),
    send: (target: WebContents, channel, ...args) => target.send(channelOf(pluginId, channel), ...args),
    get dataPath() {
      mkdirSync(dataPath, { recursive: true })
      return dataPath
    },
    sessionEnv,
    onDispose: (dispose) => disposers.push(dispose),
    chatAdapter: (id) => enabledChatAdapters().find((adapter) => adapter.id === id) ?? null
  }
  plugin.activate?.(context)
  return { dispose: () => disposers.splice(0).reverse().forEach((dispose) => dispose()) }
}

/** Brings main modules in line with the plugins enabled in the renderer */
export function setEnabledPlugins(ids: string[], userData: string): void {
  for (const [id, activation] of active) {
    if (ids.includes(id)) continue
    activation.dispose()
    active.delete(id)
  }
  for (const id of ids) {
    const plugin = MAIN_PLUGINS.get(id)
    if (plugin && !active.has(id)) active.set(id, activate(id, plugin, userData))
  }
}

export const disposePlugins = (): void => setEnabledPlugins([], '')

/** Tools of the enabled plugins, once each when several plugins share one (Jira and Confluence both use acli) */
export const enabledTools = (): ToolDefinition[] => {
  const tools = [...active.keys()].flatMap((id) => MAIN_PLUGINS.get(id)?.tools ?? [])
  return tools.filter((tool, index) => tools.findIndex((other) => other.name === tool.name) === index)
}

/** Chat adapters of the enabled plugins, first one wins per id */
export const enabledChatAdapters = (): ChatAdapter[] => adaptersOf(MAIN_PLUGINS, [...active.keys()])
