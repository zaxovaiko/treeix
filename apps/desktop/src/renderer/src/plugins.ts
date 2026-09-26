import { useSyncExternalStore } from 'react'
import type { PluginManifest, RendererPlugin, Services, SessionSummary } from '@treeix/sdk'
import { getSettings, subscribeSettings, updateSettings } from './settings'
import { setPluginThemes } from './themes'

const manifests = import.meta.glob<PluginManifest>('../../../../../packages/plugins/*/package.json', { eager: true, import: 'treeix' })
// Not eager: each plugin's renderer code is its own chunk, fetched only once the plugin is enabled
const loaders = import.meta.glob<RendererPlugin>('../../../../../packages/plugins/*/renderer/index.tsx', { import: 'default' })

const folderOf = (path: string, depth: number): string => path.split('/').at(-depth) ?? path

export type PluginEntry = { manifest: PluginManifest; load: (() => Promise<RendererPlugin>) | null }

/** Every plugin in the monorepo, by name */
export const PLUGINS: PluginEntry[] = Object.entries(manifests)
  .map(([path, manifest]) => {
    const folder = folderOf(path, 2)
    const loaderPath = Object.keys(loaders).find((candidate) => folderOf(candidate, 3) === folder)
    return { manifest, load: loaderPath ? loaders[loaderPath] : null }
  })
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))

const manifestOf = (id: string): PluginManifest | undefined => PLUGINS.find((entry) => entry.manifest.id === id)?.manifest

/** Switched on in Settings (or on by default), with every plugin it requires enabled too */
export function isPluginEnabled(id: string, choices = getSettings().plugins, seen = new Set<string>()): boolean {
  const manifest = manifestOf(id)
  if (!manifest || seen.has(id)) return false
  seen.add(id)
  const chosen = choices[id] ?? manifest.enabledByDefault
  return chosen && (manifest.requires ?? []).every((required) => isPluginEnabled(required, choices, seen))
}

export const setPluginEnabled = (id: string, enabled: boolean): void => updateSettings({ plugins: { ...getSettings().plugins, [id]: enabled } })

export type LoadedPlugin = { manifest: PluginManifest; plugin: RendererPlugin }

type State = { loaded: LoadedPlugin[]; ready: boolean }
let state: State = { loaded: [], ready: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let syncing = Promise.resolve()

/** Activates enabled plugins' main modules first, so their handlers exist before renderer code calls them */
function sync(): void {
  syncing = syncing.then(async () => {
    const enabled = PLUGINS.filter((entry) => isPluginEnabled(entry.manifest.id))
    await window.api.plugins.setEnabled(enabled.map((entry) => entry.manifest.id))
    const loaded = await Promise.all(
      enabled.map(async (entry): Promise<LoadedPlugin | null> => {
        const existing = state.loaded.find((candidate) => candidate.manifest.id === entry.manifest.id)
        if (existing) return existing
        const plugin = await entry.load?.().catch((reason: unknown) => {
          console.error(`Plugin ${entry.manifest.id} failed to load`, reason)
          return null
        })
        return plugin ? { manifest: entry.manifest, plugin } : null
      })
    )
    state = { loaded: loaded.filter((entry) => entry !== null), ready: true }
    setPluginThemes(Object.assign({}, ...state.loaded.map(({ plugin }) => plugin.themes ?? {})))
    listeners.forEach((listener) => listener())
  }).catch((reason: unknown) => console.error('Plugins could not be synced', reason))
}

let lastChoices = ''
if (typeof window !== 'undefined') {
  sync()
  subscribeSettings(() => {
    const choices = JSON.stringify(getSettings().plugins)
    if (choices === lastChoices) return
    lastChoices = choices
    sync()
  })
  lastChoices = JSON.stringify(getSettings().plugins)
}

export const usePlugins = (): State => useSyncExternalStore(subscribe, () => state)

export const loadedPlugins = (): LoadedPlugin[] => state.loaded

/** A service from an enabled plugin, null when none offers it */
export function findService<K extends keyof Services>(name: K): Services[K] | null {
  for (const { plugin } of state.loaded) {
    const service = plugin.services?.[name]
    if (service) return service
  }
  return null
}

/** Re-renders when plugins load or unload */
export function useService<K extends keyof Services>(name: K): Services[K] | null {
  usePlugins()
  return findService(name)
}

const NO_SESSIONS: SessionSummary[] = []
const noSubscription = (): (() => void) => () => undefined
const noSessions = (): SessionSummary[] => NO_SESSIONS

/** Terminal and agent sessions, empty while no plugin provides them */
export function useSessions(): SessionSummary[] {
  const service = useService('sessions')
  return useSyncExternalStore(service?.subscribe ?? noSubscription, service?.getSessions ?? noSessions)
}
