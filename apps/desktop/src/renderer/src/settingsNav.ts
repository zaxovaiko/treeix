import type { IconName } from './Icon'
import type { LoadedPlugin, PluginEntry } from './plugins'

export type SectionId = 'General' | 'Appearance' | 'Terminal' | 'Keyboard' | 'Plugins' | 'Integrations'

/** A page in Settings: one of the fixed sections, or a plugin's own page nested under Plugins */
export type PageId = SectionId | `plugin:${string}`

export const SECTIONS: [SectionId, IconName][] = [
  ['General', 'settings'],
  ['Appearance', 'palette'],
  ['Terminal', 'terminal'],
  ['Keyboard', 'keyboard'],
  ['Plugins', 'plug'],
  ['Integrations', 'cloudCheck']
]

const PLUGIN_PREFIX = 'plugin:'
export const pluginPage = (id: string): PageId => `${PLUGIN_PREFIX}${id}`
export const isPageId = (value: string): value is PageId => value.startsWith(PLUGIN_PREFIX) || SECTIONS.some(([id]) => id === value)
export const pluginOf = (page: PageId): string | null => (page.startsWith(PLUGIN_PREFIX) ? page.slice(PLUGIN_PREFIX.length) : null)

export type NavRow = { page: PageId; label: string; icon: IconName; child: boolean }

/**
 * The fixed sections, with a row under Plugins for each plugin that brings settings of its own.
 * Only a loaded plugin exposes them, so a child row appears and disappears with its switch.
 */
export function navRows(plugins: PluginEntry[], loaded: LoadedPlugin[]): NavRow[] {
  const withSettings = new Set(loaded.filter(({ plugin }) => plugin.Settings).map(({ manifest }) => manifest.id))
  const children = plugins
    .filter(({ manifest }) => withSettings.has(manifest.id))
    .map(({ manifest }): NavRow => ({ page: pluginPage(manifest.id), label: manifest.name, icon: 'plug', child: true }))
  return SECTIONS.flatMap(([id, icon]): NavRow[] => [{ page: id, label: id, icon, child: false }, ...(id === 'Plugins' ? children : [])])
}

/** A plugin page is the only page that can go missing, when its plugin is switched off while Settings remembers it */
export const openablePage = (page: PageId, rows: NavRow[]): PageId => (rows.some((row) => row.page === page) ? page : 'Plugins')

let requestedPage: PageId | null = null
const pageListeners = new Set<(page: PageId) => void>()

/** Asks Settings for a page: the open view switches to it, a closed one opens on it */
export function showSettingsPage(page: PageId): void {
  requestedPage = pageListeners.size ? null : page
  pageListeners.forEach((listener) => listener(page))
}

export function takeRequestedPage(): PageId | null {
  const page = requestedPage
  requestedPage = null
  return page
}

export function onSettingsPage(listener: (page: PageId) => void): () => void {
  pageListeners.add(listener)
  return () => pageListeners.delete(listener)
}
